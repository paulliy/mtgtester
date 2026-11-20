/**
 * Play a game between real, curated decklists (the `coverage-decks` fixtures, or any
 * Moxfield/Archidekt URL/plaintext file) instead of `pool --play`'s auto-generated decks.
 * Auto-generated decks are legal by construction but not equally *playable* — they're drawn from
 * whatever the pool happens to support, not tuned like a real precon — so exercising a specific
 * card or interaction is better served by pitting two distinct curated decks against each other.
 *
 *   bun run play-decks <deckFileOrUrl> <deckFileOrUrl> [more...] [--seed S] [--verbose]
 *                      [--provisional]   # also play machine-checked review-queue cards (H1)
 *
 * Unresolved/unmodeled cards in a deck still halt the engine (brief §5) — this is a test tool,
 * not a substitute for `bun run coverage`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { Engine, runToCompletion, type EnginePlayerConfig } from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { loadOracleIndexFromFile } from '../cards/oracle-index';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';
import {
  describeCatalog,
  loadProvisionalCatalog,
  provisionalGameConfig,
  type ProvisionalCatalog,
} from '../cards/provisional';

const BULK_PATH = 'data/scryfall-oracle-cards.json';

interface Args {
  deckInputs: string[];
  seed: string;
  verbose: boolean;
  provisional: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    deckInputs: [],
    seed: 'play-decks-demo',
    verbose: false,
    provisional: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') args.seed = argv[++i] ?? args.seed;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--provisional') args.provisional = true;
    else args.deckInputs.push(arg as string);
  }
  return args;
}

function readInput(arg: string): string {
  if (/^https?:\/\//i.test(arg)) return arg;
  return readFileSync(resolve(arg), 'utf8');
}

interface LoadedDeck {
  label: string;
  commander: OracleCard;
  cards: OracleCard[];
}

async function loadDeck(
  index: ReturnType<typeof loadOracleIndexFromFile>,
  input: string,
): Promise<LoadedDeck> {
  const raw = readInput(input);
  const parsed = await importDeck(raw);
  const { resolved, unresolvedNames } = resolveDeck(parsed, index);
  if (resolved === null) {
    throw new Error(`unresolved names in "${input}": ${unresolvedNames.join(', ')}`);
  }
  const commander = resolved.commanders[0];
  if (commander === undefined) {
    throw new Error(`"${input}" has no commander`);
  }
  const cards: OracleCard[] = [
    ...(resolved.companion === null ? [] : [resolved.companion]),
    ...resolved.cards.flatMap((e) => Array.from({ length: e.quantity }, () => e.card)),
  ];
  return { label: resolved.name ?? parsed.name ?? input, commander, cards };
}

function formatPlayerLives(engine: Engine): string {
  const state = engine.getState();
  return state.players.map((p) => `${p.id}:${p.hasLost ? 'DEAD' : p.life}`).join('  ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.deckInputs.length < 2) {
    console.error(
      'Usage: bun run play-decks <deckFileOrUrl> <deckFileOrUrl> [more...] [--seed S] [--verbose]',
    );
    process.exitCode = 2;
    return;
  }

  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const index = loadOracleIndexFromFile(resolve(BULK_PATH));

  const decks: LoadedDeck[] = [];
  for (const input of args.deckInputs) {
    console.log(`Loading deck "${input}" …`);
    decks.push(await loadDeck(index, input));
  }

  console.log('\nDecks in play');
  console.log('─'.repeat(13));
  decks.forEach((deck, i) => {
    console.log(
      `  P${i + 1}  ${deck.commander.name}  (${deck.label}, ${deck.cards.length + 1} cards)`,
    );
  });

  const players: EnginePlayerConfig[] = decks.map((deck, i) => ({
    id: `P${i + 1}`,
    deckId: `deck-${i + 1}`,
    commanders: [deck.commander],
    cards: deck.cards,
  }));

  console.log(`\nPlaying ${players.length}-player game (Heuristic Bot Providers)…`);
  let provisional: ProvisionalCatalog | undefined;
  if (args.provisional) {
    provisional = loadProvisionalCatalog(index);
    console.log(describeCatalog(provisional));
  }
  const engine = new Engine({
    gameId: 'play-decks-demo',
    seed: args.seed,
    players,
    turnCap: 200,
    ...provisionalGameConfig(provisional, players),
  });
  const providers = new Map<string, HeuristicDecisionProvider>();
  let surfacedDecisions = 0;

  const result = runToCompletion(
    engine,
    (playerId) => {
      let provider = providers.get(playerId);
      if (provider === undefined) {
        provider = new HeuristicDecisionProvider(`${args.seed}-${playerId}`, () =>
          engine.view(playerId),
        );
        providers.set(playerId, provider);
      }
      return provider;
    },
    {
      onDecision(req, res) {
        surfacedDecisions++;
        if (args.verbose) {
          const chosen = req.legalActions.find((a) => a.id === res.actionId);
          console.log(
            `  [Turn ${req.turn}] [${req.decidingPlayer}] (${req.phase}) → "${chosen?.description ?? `Action ${res.actionId}`}"`,
          );
        }
      },
    },
  );

  console.log('\nGame Result Summary');
  console.log('─'.repeat(19));
  if (result.halted) {
    console.log(`  ✗ HALTED — ${result.haltReason ?? 'unknown reason'}`);
    if (result.provisionalCards !== undefined)
      console.log(`    Provisional cards in play: ${result.provisionalCards.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ Winner:             ${result.winnerSeat ?? '(draw)'}`);
  console.log(`    Total Turns:        ${result.turnCount}`);
  console.log(`    Surfaced Decisions: ${surfacedDecisions.toLocaleString()}`);
  console.log(`    Elimination Order:  ${result.finishingOrder.join(' → ') || '(none)'}`);
  console.log(`    Final Life Totals:  ${formatPlayerLives(engine)}`);
  if (result.provisionalCards !== undefined)
    console.log(
      `    Provisional cards:  ${result.provisionalCards.length} (unreviewed: ${result.provisionalCards.join(', ')})`,
    );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
