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
import { EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS } from './token-triumph-support';

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

// allowed-skip: needs the Scryfall bulk file (data/scryfall-oracle-cards.json, gitignored)
describe.skipIf(SKIP)('Token Triumph Deck — L1-L7 Test Suite', () => {
  // `describe.skipIf` still calls this factory to collect its `it`s (only the `it` bodies
  // themselves are skipped) — so without this guard, `loadTokenTriumphDeckCards()` below would
  // still throw during collection even when the suite is meant to be skipped for a missing
  // Scryfall bulk file, defeating the skip entirely.
  if (SKIP) return;

  const { commanderCard, deckCards } = loadTokenTriumphDeckCards();
  const allUniqueCards = Array.from(new Set([commanderCard, ...deckCards]));

  const expectedUnsupported = new Set(EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS);

  it('records every unsupported card explicitly instead of claiming full-deck coverage', () => {
    const unsupported = allUniqueCards.filter((card) => !interpretCard(card).modeled);
    expect(new Set(unsupported.map((card) => card.name))).toEqual(expectedUnsupported);
    for (const card of unsupported) {
      expect(interpretCard(card).unmodeledReasons.join('\n'), card.name).toContain(
        'explicitly unsupported:',
      );
    }
  });

  it('halts the original deck when an unsupported card is reached, or plays on when every card is modeled', () => {
    const forestCard = allUniqueCards.find((card) => card.name === 'Forest')!;
    const plainsCard = allUniqueCards.find((card) => card.name === 'Plains')!;
    const opponentDeck = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? forestCard : plainsCard,
    );
    const engine = makeEngine([{ cards: deckCards }, { cards: opponentDeck }], {
      seed: 'token-triumph-l3-seed',
    });
    const provider = new RuleBasedProvider([whenChoose({ option: /./ })], { fallback: 'first' });
    for (let i = 0; i < 20_000; i++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'continue') continue;
      engine.submit(provider.decide(step.request));
    }
    if (expectedUnsupported.size === 0) {
      // Every card in the deck is modeled now, so nothing halts it.
      expect(engine.getResult()?.halted ?? false).toBe(false);
      return;
    }
    expect(engine.getResult()?.halted).toBe(true);
    expect(engine.getResult()?.haltReason).toMatch(/unmodeled|unsupported/i);
  });

  it('plays several turns with a 100-card supported subset', () => {
    const forestCard = allUniqueCards.find((card) => card.name === 'Forest')!;
    const plainsCard = allUniqueCards.find((card) => card.name === 'Plains')!;
    let replacement = 0;
    const playableDeck = deckCards.map((card) =>
      interpretCard(card).modeled ? card : replacement++ % 2 === 0 ? forestCard : plainsCard,
    );
    const opponentDeck = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? forestCard : plainsCard,
    );
    const engine = makeEngine([{ cards: playableDeck }, { cards: opponentDeck }], {
      seed: 'token-triumph-supported-subset',
    });
    const provider = new RuleBasedProvider([whenChoose({ option: /./ })], { fallback: 'first' });
    for (let i = 0; i < 20_000; i++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'continue') continue;
      engine.submit(provider.decide(step.request));
      if (engine.getState().turnNumber > 1) break;
    }
    expect(engine.getResult()?.halted ?? false).toBe(false);
    expect(engine.getState().turnNumber).toBeGreaterThan(1);
  });
});
