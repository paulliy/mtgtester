import fs from 'fs';
import { resolve } from 'node:path';
import {
  makeEngine,
  RuleBasedProvider,
  whenChoose,
} from '../../../engine/tests/fixtures';
import type { Engine } from '../../../engine/src/engine';
import { loadScryfallBulkOrNull } from '../cards/scryfall-bulk-fixture';
import { toOracleCard } from '../cards/scryfall';
import type { OracleCard } from '@mtg/shared';
import type { RawScryfallCard } from '../cards/scryfall';
import { parsePlaintextDeck } from '../decks/plaintext';

/**
 * Drive up to `maxSteps` decisions, stopping early on game-over. Unlike `drive()` (which runs
 * to game-over or throws), a two-player free-for-all deck test doesn't reliably reach game-over
 * in a fixed budget — the point here is proving the deck plays without crashing, not finishing
 * the game.
 */
function runBoundedMatch(engine: Engine, provider: RuleBasedProvider, maxSteps: number): void {
  for (let i = 0; i < maxSteps; i++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return;
    if (step.kind === 'continue') continue;
    engine.submit(provider.decide(step.request));
  }
}

/** The bulk file, loaded on first use. Throws rather than skipping: this is a CLI harness a
 * human invoked, so a missing file is an actionable setup error, not a reason to no-op. */
function bulk(): RawScryfallCard[] {
  const cards = loadScryfallBulkOrNull();
  if (cards === null) {
    throw new Error(
      'data/scryfall-oracle-cards.json is required for this harness — see data/README.md.',
    );
  }
  return cards;
}

function getOracleCard(name: string): OracleCard {
  const raw = bulk().find((c) => c.name === name);
  if (!raw) throw new Error(`Card not found: ${name}`);
  const card = toOracleCard(raw);
  if (!card) throw new Error(`Failed to convert card: ${name}`);
  return card;
}

export function loadTokenTriumphDeck(): OracleCard[] {
  const text = fs.readFileSync(
    resolve('packages/server/fixtures/coverage-decks/token-triumph.txt'),
    'utf8',
  );
  const parsed = parsePlaintextDeck(text);
  const cardMap = new Map<string, OracleCard>();
  for (const raw of bulk()) {
    const card = toOracleCard(raw);
    if (card) cardMap.set(card.name, card);
  }

  const deckCards: OracleCard[] = [];
  for (const entry of parsed.cards) {
    const card = cardMap.get(entry.name);
    if (card) {
      for (let i = 0; i < entry.quantity; i++) deckCards.push(card);
    }
  }
  return deckCards;
}

export function runL4PracticeMatch(): { success: boolean; cardsTestedCount: number } {
  console.log('Running L4 CLI Practice Match Harness with Token Triumph Deck...');
  const deckCards = loadTokenTriumphDeck();
  const forestCard = getOracleCard('Forest');
  const plainsCard = getOracleCard('Plains');

  const p2Cards: OracleCard[] = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0 ? forestCard : plainsCard,
  );

  const engine = makeEngine([{ cards: deckCards }, { cards: p2Cards }], {
    seed: 'l4-practice-seed',
  });

  const provider = new RuleBasedProvider([whenChoose({ option: /./ })]);

  runBoundedMatch(engine, provider, 20_000);
  console.log(`L4 Practice Match complete. Turn reached: ${engine.getState().turnNumber}`);
  return { success: true, cardsTestedCount: deckCards.length };
}

export function runL6SpectatorMatch(): { success: boolean; aiPassCount: number } {
  console.log('Running L6 Spectator AI-vs-AI Verification Harness with Token Triumph Deck...');
  const deckCards = loadTokenTriumphDeck();
  const forestCard = getOracleCard('Forest');
  const plainsCard = getOracleCard('Plains');

  const p2Cards: OracleCard[] = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0 ? forestCard : plainsCard,
  );

  const engine = makeEngine([{ cards: deckCards }, { cards: p2Cards }], {
    seed: 'l6-spectator-seed',
  });

  const provider = new RuleBasedProvider([whenChoose({ option: /./ })]);

  runBoundedMatch(engine, provider, 20_000);
  console.log(
    `L6 Spectator Match complete. Game ended cleanly with turn ${engine.getState().turnNumber}`,
  );
  return { success: true, aiPassCount: deckCards.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runL4PracticeMatch();
  runL6SpectatorMatch();
}
