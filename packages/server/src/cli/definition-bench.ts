/**
 * Game-start benchmark for the per-process definition cache (plan E9).
 *
 *   bun run packages/server/src/cli/definition-bench.ts [--reps N]
 *
 * Starts a two-seat game for each coverage deck (the deck against the next one) N times and
 * reports the time spent in `createGame`. It runs twice: "cold" forgets every cached definition
 * before each game, which is what every game paid before the cache; "warm" keeps the cache, which
 * is what a batch, fuzz run or table server pays after its first game with a deck.
 */
import { clearDefinitionCache, createGame, definitionCacheSize } from '@mtg/engine';
import { loadDecks } from './fuzz-plan';
import type { FuzzDeck } from './fuzz-game';

function parseReps(argv: string[]): number {
  const at = argv.indexOf('--reps');
  if (at === -1) return 50;
  const reps = Number(argv[at + 1]);
  if (!Number.isSafeInteger(reps) || reps < 1)
    throw new Error('--reps takes a whole number of at least 1');
  return reps;
}

function startGame(a: FuzzDeck, b: FuzzDeck, rep: number): void {
  createGame({
    gameId: `definition-bench-${rep}`,
    seed: `definition-bench-${rep}`,
    players: [a, b].map((deck, seat) => ({
      id: `P${seat + 1}`,
      deckId: deck.label,
      commanders: deck.commanders,
      cards: deck.cards,
    })),
  });
}

function run(decks: FuzzDeck[], reps: number, cold: boolean): number {
  clearDefinitionCache();
  const start = performance.now();
  for (let rep = 0; rep < reps; rep++) {
    for (let i = 0; i < decks.length; i++) {
      if (cold) clearDefinitionCache();
      startGame(decks[i]!, decks[(i + 1) % decks.length]!, rep);
    }
  }
  return performance.now() - start;
}

const reps = parseReps(process.argv.slice(2));
const decks = await loadDecks();
const games = reps * decks.length;
// One untimed pass so module loading and JIT warm-up land in neither column.
run(decks, 1, true);
const coldMs = run(decks, reps, true);
const warmMs = run(decks, reps, false);
console.log(`${games} game starts (${decks.length} decks x ${reps})`);
console.log(`cold: ${coldMs.toFixed(0)} ms total, ${(coldMs / games).toFixed(2)} ms per game`);
console.log(`warm: ${warmMs.toFixed(0)} ms total, ${(warmMs / games).toFixed(2)} ms per game`);
console.log(`cached definitions: ${definitionCacheSize()}`);
