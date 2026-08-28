import fs from 'fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { makeEngine, RuleBasedProvider, whenChoose } from '../../../engine/tests/fixtures';
import { loadScryfallBulkOrNull } from './scryfall-bulk-fixture';
import { toOracleCard } from './scryfall';
import type { OracleCard } from '@mtg/shared';
import { parsePlaintextDeck } from '../decks/plaintext';
import { registerTOKEN_TRIUMPHOverrides } from '../../../engine/src/cards/overrides/token-triumph';

registerTOKEN_TRIUMPHOverrides();

const scryfallCards = loadScryfallBulkOrNull();
// data/scryfall-oracle-cards.json is gitignored and not fetched by CI (see scryfall-bulk-fixture.ts).
const SKIP = scryfallCards === null;

function loadTokenTriumphDeckCards(): { commanderCard: OracleCard; deckCards: OracleCard[] } {
  const filePath = resolve('packages/server/fixtures/coverage-decks/token-triumph.txt');
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parsePlaintextDeck(text);

  const cardMap = new Map<string, OracleCard>();
  for (const raw of scryfallCards ?? []) {
    const card = toOracleCard(raw);
    if (card) cardMap.set(card.name, card);
  }

  const commanderName = parsed.commanderNames[0] ?? 'Emmara, Soul of the Accord';
  const commanderCard = cardMap.get(commanderName);
  if (!commanderCard) throw new Error(`Commander card not found: ${commanderName}`);

  const deckCards: OracleCard[] = [];
  for (const entry of parsed.cards) {
    const card = cardMap.get(entry.name);
    if (!card) throw new Error(`Deck card not found: ${entry.name}`);
    for (let i = 0; i < entry.quantity; i++) {
      deckCards.push(card);
    }
  }

  return { commanderCard, deckCards };
}

describe.skipIf(SKIP)('Token Triumph Deck — L1-L7 Test Suite', () => {
  // `describe.skipIf` still calls this factory to collect its `it`s (only the `it` bodies
  // themselves are skipped) — so without this guard, `loadTokenTriumphDeckCards()` below would
  // still throw during collection even when the suite is meant to be skipped for a missing
  // Scryfall bulk file, defeating the skip entirely.
  if (SKIP) return;

  const { commanderCard, deckCards } = loadTokenTriumphDeckCards();
  const allUniqueCards = Array.from(new Set([commanderCard, ...deckCards]));

  it('L1: Modeled cards in Token Triumph deck pass L1 smoke check with no unmodeled reasons', () => {
    const modeledCards = allUniqueCards.filter((card) => interpretCard(card).modeled);
    expect(modeledCards.length).toBeGreaterThanOrEqual(65);
    for (const card of modeledCards) {
      const def = interpretCard(card);
      expect(def.unmodeledReasons, `Card ${card.name} has unmodeled reasons`).toEqual([]);
    }
  });

  it('L2 & L3: Full 100-card Token Triumph deck runs through engine priority and legality pipeline', () => {
    const forestCard = allUniqueCards.find((c) => c.name === 'Forest')!;
    const plainsCard = allUniqueCards.find((c) => c.name === 'Plains')!;
    const opponentDeck = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? forestCard : plainsCard));

    const engine = makeEngine([
      { cards: deckCards },
      { cards: opponentDeck },
    ], { seed: 'token-triumph-l3-seed' });

    const provider = new RuleBasedProvider([
      whenChoose({ option: /./ }),
    ]);

    // Bounded drive: this two-player free-for-all doesn't reliably reach game-over in a fixed
    // step budget, so run enough decisions to prove the deck plays several turns without
    // crashing rather than waiting for `drive()`'s unbounded run-to-gameOver.
    for (let i = 0; i < 20_000; i++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'continue') continue;
      engine.submit(provider.decide(step.request));
    }
    expect(engine.getState().turnNumber).toBeGreaterThan(1);
  });

  it('L7: Confirm deck coverage signal for Token Triumph deck', () => {
    let modeledCount = 0;
    for (const card of allUniqueCards) {
      const def = interpretCard(card);
      if (def.modeled) modeledCount++;
    }
    expect(modeledCount).toBeGreaterThanOrEqual(67);
  });
});
