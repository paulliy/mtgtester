/**
 * The engine-supported card pool, and playable decks built from it.
 *
 *   bun run pool                      # what the engine can currently play with
 *   bun run pool --commanders         # every commander the pool supports
 *   bun run pool --play [--seed S]    # build 4 decks and play a full game
 *   bun run pool --play --verbose     # live turn-by-turn decision debug output
 *   bun run pool --play --ai          # play a game with AI-driven players
 *   bun run pool --write [--seed S]   # write the 4 decks as committed fixtures
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DecisionRequest, DecisionResponse, OracleCard } from '@mtg/shared';
import {
  Engine,
  RandomDecisionProvider,
  runToCompletion,
  runToCompletionAsync,
  type EnginePlayerConfig,
} from '@mtg/engine';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import {
  basicLandsByColor,
  buildSupportedPool,
  commandersIn,
  poolForIdentity,
  type SupportedPool,
} from '../cards/pool';
import { generateCommanderDeck, toPlaintext, type GeneratedDeck } from '../decks/generate';
import {
  AiCallLogger,
  DailyQuotaExhaustedError,
  loadAiConfig,
  NoAvailableModelError,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  RequestQueue,
} from '../ai';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const FIXTURE_DIR = 'packages/server/fixtures/generated-decks';
const SEATS = 4;

interface Args {
  commanders: boolean;
  play: boolean;
  ai: boolean;
  write: boolean;
  seed: string;
  verbose: boolean;
  providerUrl?: string;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commanders: false, play: false, ai: false, write: false, seed: 'pool-demo', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commanders') args.commanders = true;
    else if (arg === '--play') args.play = true;
    else if (arg === '--ai') args.ai = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--seed') args.seed = argv[++i] ?? args.seed;
    else if (arg === '--provider-url') { const val = argv[++i]; if (val !== undefined) args.providerUrl = val; }
    else if (arg === '--model') { const val = argv[++i]; if (val !== undefined) args.model = val; }
  }
  return args;
}

function loadPool(): SupportedPool {
  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const parsed: unknown = JSON.parse(readFileSync(resolve(BULK_PATH), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in "${BULK_PATH}".`);

  const cards: OracleCard[] = [];
  for (const raw of parsed as RawScryfallCard[]) {
    const card = toOracleCard(raw);
    if (card !== null) cards.push(card);
  }
  return buildSupportedPool(cards);
}

function reportPool(pool: SupportedPool): void {
  const lands = pool.cards.filter((c) => c.isLand).length;
  const pct = ((pool.cards.length / pool.considered) * 100).toFixed(1);

  console.log('\nEngine-supported card pool');
  console.log('─'.repeat(26));
  console.log(`  commander-legal cards: ${pool.considered.toLocaleString()}`);
  console.log(`  modeled (playable):    ${pool.cards.length.toLocaleString()} (${pct}%)`);
  console.log(`    lands:               ${lands}`);
  console.log(`    nonlands:            ${pool.cards.length - lands}`);
  console.log(`  usable commanders:     ${commandersIn(pool).length}`);
  console.log(`  basic lands available: ${[...basicLandsByColor(pool).keys()].sort().join('') || '(none)'}`);
}

function buildDecks(pool: SupportedPool, seed: string): GeneratedDeck[] {
  return Array.from({ length: SEATS }, (_, i) =>
    generateCommanderDeck(pool, { seed: `${seed}-seat${i + 1}` }),
  );
}

function describeDeck(index: number, deck: GeneratedDeck): void {
  const identity = [...deck.commander.colorIdentity].sort().join('') || 'C';
  console.log(
    `  P${index + 1}  {${identity}}  ${deck.commander.name}` +
      `  (${deck.cards.length + 1} cards)`,
  );
}

function formatPlayerLives(engine: Engine): string {
  const state = engine.getState();
  return state.players
    .map((p) => `${p.id}:${p.hasLost ? 'DEAD' : p.life}`)
    .join('  ');
}

function logDecisionProgress(
  engine: Engine,
  req: DecisionRequest,
  res: DecisionResponse,
  decisionNum: number,
  verbose: boolean,
  lastTurnReported: { turn: number },
): void {
  const state = engine.getState();
  const chosenAction = req.legalActions.find((a) => a.id === res.actionId);
  const actionDesc = chosenAction?.description ?? `Action ${res.actionId}`;

  if (verbose) {
    console.log(
      `  [Turn ${req.turn}] [${req.decidingPlayer}] d#${decisionNum} (${req.phase}) → "${actionDesc}"${res.note ? ` (${res.note})` : ''}`,
    );
  } else if (state.turnNumber > lastTurnReported.turn) {
    lastTurnReported.turn = state.turnNumber;
    console.log(
      `  ▶ Turn ${state.turnNumber.toString().padStart(3)}  |  ${formatPlayerLives(engine)}  |  ${state.eventLog.length.toLocaleString()} events`,
    );
  }
}

function playRandom(pool: SupportedPool, seed: string, verbose: boolean): void {
  const decks = buildDecks(pool, seed);
  console.log('\nGenerated decks');
  console.log('─'.repeat(15));
  decks.forEach((deck, i) => describeDeck(i, deck));

  const players: EnginePlayerConfig[] = decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `generated-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));

  console.log(`\nPlaying four-player game (Random Decision Providers) [${verbose ? 'VERBOSE' : 'LIVE PROGRESS'}]…`);
  const engine = new Engine({ gameId: 'pool-demo', seed, players, turnCap: 200 });
  const providers = new Map<string, RandomDecisionProvider>();
  
  let surfacedDecisions = 0;
  const lastTurnReported = { turn: 0 };

  const result = runToCompletion(engine, (playerId) => {
    let provider = providers.get(playerId);
    if (provider === undefined) {
      provider = new RandomDecisionProvider(`${seed}-${playerId}`);
      providers.set(playerId, provider);
    }
    return provider;
  }, {
    onDecision(req, res) {
      surfacedDecisions++;
      logDecisionProgress(engine, req, res, surfacedDecisions, verbose, lastTurnReported);
    },
  });

  console.log('\nGame Result Summary');
  console.log('─'.repeat(19));
  if (result.halted) {
    console.log(`  ✗ HALTED — ${result.haltReason ?? 'unknown reason'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ Winner:             ${result.winnerSeat ?? '(draw)'}`);
  console.log(`    Total Turns:        ${result.turnCount}`);
  console.log(`    Surfaced Decisions: ${surfacedDecisions.toLocaleString()}`);
  console.log(`    Total Game Events:  ${engine.getState().eventLog.length.toLocaleString()}`);
  console.log(`    Elimination Order:  ${result.finishingOrder.join(' → ') || '(none)'}`);
  console.log(`    Final Life Totals:  ${formatPlayerLives(engine)}`);
}

async function playAi(pool: SupportedPool, args: Args): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (args.providerUrl !== undefined) env['AI_BASE_URL'] = args.providerUrl;
  if (args.model !== undefined) env['AI_MODELS'] = args.model;

  const config = loadAiConfig(env);

  if (!config.apiKey) {
    console.error(
      '\nError: No AI API key found.\nPlease set AI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY in your environment or .env file.\nSee .env.example for details.\n',
    );
    process.exitCode = 1;
    return;
  }

  const decks = buildDecks(pool, args.seed);
  console.log('\nGenerated decks');
  console.log('─'.repeat(15));
  decks.forEach((deck, i) => describeDeck(i, deck));

  const players: EnginePlayerConfig[] = decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `generated-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));

  console.log(`\nPlaying four-player game (AI Agents) [${args.verbose ? 'VERBOSE' : 'LIVE PROGRESS'}]…`);
  console.log(`  Endpoint:     ${config.baseUrl}`);
  console.log(`  Model chain:  ${config.models.join(' → ')}`);
  console.log(`  RPM ceiling:  ${config.rpmLimit}`);

  const engine = new Engine({ gameId: 'pool-ai-demo', seed: args.seed, players, turnCap: 200 });
  const client = new OpenAiCompatibleClient(config);
  const queue = new RequestQueue(config);
  const logger = new AiCallLogger(null, 'pool-ai-demo');

  const providers = new Map<string, OpenAiDecisionProvider>();
  const providerFor = (playerId: string): OpenAiDecisionProvider => {
    let p = providers.get(playerId);
    if (p === undefined) {
      p = new OpenAiDecisionProvider(client, queue, engine, config, logger);
      providers.set(playerId, p);
    }
    return p;
  };

  let surfacedDecisions = 0;
  const lastTurnReported = { turn: 0 };

  let result;
  try {
    result = await runToCompletionAsync(engine, providerFor, {
      onDecision(req, res) {
        surfacedDecisions++;
        logDecisionProgress(engine, req, res, surfacedDecisions, args.verbose, lastTurnReported);
      },
    });
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError || err instanceof NoAvailableModelError) {
      const stats = logger.summary();
      console.error(`\n✗ Game abandoned on turn ${engine.getState().turnNumber} — ${err.message}`);
      console.error(
        `  ${stats.totalCalls} AI calls made across ${surfacedDecisions} surfaced decisions before the budget ran out.`,
      );
      console.error('  Retry tomorrow, add another key/provider (AI_BASE_URL + AI_API_KEY), or run without --ai.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log('\nGame Result Summary');
  console.log('─'.repeat(19));
  if (result.halted) {
    console.log(`  ✗ HALTED — ${result.haltReason ?? 'unknown reason'}`);
    process.exitCode = 1;
    return;
  }

  const aiStats = logger.summary();
  console.log(`  ✓ Winner:             ${result.winnerSeat ?? '(draw)'}`);
  console.log(`    Total Turns:        ${result.turnCount}`);
  console.log(`    Surfaced Decisions: ${surfacedDecisions.toLocaleString()}`);
  console.log(`    Total Game Events:  ${engine.getState().eventLog.length.toLocaleString()}`);
  console.log(`    Elimination Order:  ${result.finishingOrder.join(' → ') || '(none)'}`);
  console.log(`    Final Life Totals:  ${formatPlayerLives(engine)}`);
  console.log(`    Active Model:       ${client.activeModel}`);
  if (aiStats.totalCalls > 0) {
    console.log(`    AI Calls Total:     ${aiStats.totalCalls} (${aiStats.retries} retries, ${aiStats.fallbacks} fallbacks)`);
    const skipRate =
      aiStats.totalDecisions > 0
        ? Math.round((aiStats.skippedCalls / aiStats.totalDecisions) * 100)
        : 0;
    console.log(`    Calls Skipped:      ${aiStats.skippedCalls} of ${aiStats.totalDecisions} decisions answered locally (${skipRate}%)`);
    console.log(`    Tokens Used:        ${aiStats.totalPromptTokens.toLocaleString()} prompt / ${aiStats.totalResponseTokens.toLocaleString()} completion`);
    console.log(`    Avg Latency:        ${aiStats.avgLatencyMs}ms`);
  }
}

function write(pool: SupportedPool, seed: string): void {
  mkdirSync(resolve(FIXTURE_DIR), { recursive: true });
  buildDecks(pool, seed).forEach((deck, i) => {
    const name = `generated-${i + 1}-${deck.commander.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    writeFileSync(resolve(FIXTURE_DIR, `${name}.txt`), toPlaintext(deck, name), 'utf8');
    console.log(`✓ ${name}.txt`);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = loadPool();
  reportPool(pool);

  if (args.commanders) {
    console.log('\nSupported commanders');
    console.log('─'.repeat(20));
    for (const entry of commandersIn(pool)) {
      const identity = entry.identity || 'C';
      const usable = poolForIdentity(pool, entry.identity).filter((c) => !c.isLand).length;
      console.log(`  {${identity.padEnd(5)}} ${entry.card.name.padEnd(34)} ${usable} nonland cards`);
    }
  }

  if (args.write) write(pool, args.seed);
  if (args.play) {
    if (args.ai) {
      await playAi(pool, args);
    } else {
      playRandom(pool, args.seed, args.verbose);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
