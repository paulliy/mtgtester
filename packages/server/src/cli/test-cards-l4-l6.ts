import fs from 'fs';
import { resolve } from 'node:path';
import { makeEngine, RuleBasedProvider, whenChoose } from '../../../engine/tests/fixtures';
import { interpretCard } from '../../../engine/src/cards/interpret';
import type { Engine } from '../../../engine/src/engine';
import { loadScryfallBulkOrNull } from '../cards/scryfall-bulk-fixture';
import { toOracleCard } from '../cards/scryfall';
import type { OracleCard } from '@mtg/shared';
import type { RawScryfallCard } from '../cards/scryfall';
import { parsePlaintextDeck } from '../decks/plaintext';
import { type CheckResult, RequiredInputError } from './card-test-reporting';

/**
 * A deterministic, bounded rules-engine smoke. This does not evaluate gameplay AI and does not
 * prove any individual card: it records only events the engine actually observed.
 */
export function runBoundedMatch(
  engine: Engine,
  provider: RuleBasedProvider,
  maxSteps: number,
): {
  completed: boolean;
  budgetExhausted: boolean;
  decisions: number;
  casts: number;
  activations: number;
  resolutions: number;
  turnReached: number;
  halted: boolean;
  haltReason: string | null;
} {
  let completed = false;
  let decisions = 0;
  for (let i = 0; i < maxSteps; i++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') {
      completed = true;
      break;
    }
    if (step.kind === 'continue') continue;
    engine.submit(provider.decide(step.request));
    decisions++;
  }
  const events = engine.getState().eventLog;
  const result = engine.getResult();
  return {
    completed,
    budgetExhausted: !completed,
    decisions,
    casts: events.filter((event) => event.type === 'castSpell').length,
    activations: events.filter((event) => event.type === 'activateAbility').length,
    resolutions: events.filter((event) => event.type === 'resolved').length,
    turnReached: engine.getState().turnNumber,
    halted: result?.halted ?? false,
    haltReason: result?.haltReason ?? null,
  };
}

/** The bulk file, loaded on first use. Throws rather than skipping: this is a CLI harness a
 * human invoked, so a missing file is an actionable setup error, not a reason to no-op. */
function bulk(): RawScryfallCard[] {
  const cards = loadScryfallBulkOrNull();
  if (cards === null) {
    throw new RequiredInputError(
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

export function loadTokenTriumphDeck(): { commander: OracleCard; cards: OracleCard[] } {
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

  const commanderName = parsed.commanderNames[0];
  if (commanderName === undefined) throw new Error('Token Triumph deck has no commander');
  const commander = cardMap.get(commanderName);
  if (commander === undefined) throw new Error(`Card not found: ${commanderName}`);

  const deckCards: OracleCard[] = [];
  for (const entry of parsed.cards) {
    const card = cardMap.get(entry.name);
    if (card) {
      for (let i = 0; i < entry.quantity; i++) deckCards.push(card);
    }
  }
  return { commander, cards: deckCards };
}

function runRuleBasedBoundedSmoke(id: string, label: string, seed: string): CheckResult {
  const { commander, cards: deckCards } = loadTokenTriumphDeck();
  const forestCard = getOracleCard('Forest');
  const plainsCard = getOracleCard('Plains');

  const p2Cards: OracleCard[] = Array.from({ length: 100 }, (_, i) =>
    i % 2 === 0 ? forestCard : plainsCard,
  );
  let replacement = 0;
  const supportedDeck = deckCards.map((card) =>
    interpretCard(card).modeled ? card : replacement++ % 2 === 0 ? forestCard : plainsCard,
  );

  const engine = makeEngine([{ commander, cards: supportedDeck }, { cards: p2Cards }], {
    seed,
  });
  const provider = new RuleBasedProvider(
    [whenChoose({ option: /^Play /, once: false }), whenChoose({ option: /^Cast /, once: false })],
    { fallback: 'first' },
  );
  const observed = runBoundedMatch(engine, provider, 20_000);
  const status =
    !observed.halted &&
    observed.decisions > 0 &&
    observed.turnReached > 1 &&
    observed.casts > 0 &&
    observed.resolutions > 0
      ? ('passed' as const)
      : ('failed' as const);
  return {
    id,
    label,
    kind: 'bounded-engine',
    status,
    executed: observed.decisions,
    passed: status === 'passed' ? 1 : 0,
    failed: status === 'failed' ? 1 : 0,
    skipped: 0,
    detail:
      `${observed.completed ? 'game completed' : 'decision budget exhausted'}; ` +
      `${observed.decisions} decisions, ${observed.casts} casts, ` +
      `${observed.activations} activations, ${observed.resolutions} resolutions, ` +
      `turn ${observed.turnReached}` +
      (observed.haltReason === null ? '' : `; halted: ${observed.haltReason}`),
  };
}

export function runL4PracticeMatch(): CheckResult {
  return runRuleBasedBoundedSmoke(
    'l4-bounded-rules',
    'L4 deterministic bounded rules-engine smoke',
    'l4-practice-seed',
  );
}

export function runL6SpectatorMatch(): CheckResult {
  return runRuleBasedBoundedSmoke(
    'l6-bounded-policy',
    'L6 deterministic rule-based-provider bounded smoke',
    'l6-spectator-seed',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const result of [runL4PracticeMatch(), runL6SpectatorMatch()]) {
    console.log(`${result.label}: ${result.status.toUpperCase()} — ${result.detail}`);
    if (result.status !== 'passed') process.exitCode = 1;
  }
}
