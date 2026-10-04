import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard, ServerToClientMessage } from '@mtg/shared';
import { RandomDecisionProvider } from '@mtg/engine';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { MatchSession } from '../match/session';
import type { SeatSetup } from '../match/setup';
import { parsePlaintextDeck } from '../decks/plaintext';
import { loadScryfallBulkOrNull } from './scryfall-bulk-fixture';
import { toOracleCard } from './scryfall';

const scryfallCards = loadScryfallBulkOrNull();
// data/scryfall-oracle-cards.json is gitignored and not fetched by CI (see scryfall-bulk-fixture.ts).
const SKIP = scryfallCards === null;

const livingFixture = resolve('packages/server/fixtures/coverage-decks/living-energy.txt');
const livingParsed = parsePlaintextDeck(readFileSync(livingFixture, 'utf8'));
const oracleByName = new Map<string, OracleCard>();
for (const raw of scryfallCards ?? []) {
  const card = toOracleCard(raw);
  if (card !== null) oracleByName.set(card.name, card);
}

function realCard(name: string): OracleCard {
  const card = oracleByName.get(name);
  if (card === undefined) throw new Error(`Card not found in Scryfall data: ${name}`);
  return card;
}

const CATALOG_CONTAINED = new Set([
  'Lightning Runner',
  'Aetheric Amplifier',
  'Peema Trailblazer',
  'Saheeli, Radiant Creator',
  'Saheeli, Sublime Artificer',
  'Attune with Aether',
  'Aetherworks Marvel',
  'Territorial Aetherkite',
  'Duplicant',
  "Conjurer's Closet",
  'Soul-Guide Lantern',
  'Adaptive Omnitool',
  'Bespoke Battlewagon',
  'Druid of Purification',
  'Aether Hub',
  'Solar Transformer',
  'Retrofitter Foundry',
  'Chaos Warp',
  'Reality Shift',
]);

function livingDeckCards(): { commander: OracleCard; cards: OracleCard[] } {
  const commanderName = livingParsed.commanderNames[0];
  if (commanderName === undefined) throw new Error('Living Energy fixture has no commander');
  const cards = livingParsed.cards.flatMap(({ name, quantity }) =>
    Array.from({ length: quantity }, () => realCard(name)),
  );
  return { commander: realCard(commanderName), cards };
}

function livingSeat(seat: string, commander: OracleCard, cards: OracleCard[]): SeatSetup {
  return {
    seat,
    deckSnapshotId: null,
    config: { id: seat, deckId: `living-energy-${seat}`, commanders: [commander], cards },
    summary: {
      seat,
      deckId: `living-energy-${seat}`,
      label: 'Living Energy',
      commanderNames: [commander.name],
      colorIdentity: [...commander.colorIdentity],
      archetypeTag: 'Temur — Living Energy',
    },
  };
}

describe.skipIf(SKIP)('Living Energy modeled-card and player-experience checks', () => {
  it('models every unique card except the catalog-contained backlog', () => {
    const names = new Set([
      ...livingParsed.commanderNames,
      ...livingParsed.cards.map((entry) => entry.name),
    ]);
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      const def = interpretCard(realCard(name));
      if (CATALOG_CONTAINED.has(name)) {
        expect(def.modeled, `${name} should stay fail-closed`).toBe(false);
        continue;
      }
      expect(def.modeled, `${name} is not modeled`).toBe(true);
      expect(def.unmodeledReasons, `${name} still has parser reasons`).toEqual([]);
    }
  });

  it('is catalog-contained because chosen permanents use the choosing player, not you', () => {
    const card = realCard('Druid of Purification');
    const def = interpretCard(card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain(
      'Each player chooses a permanent they do not control, not a permanent you do not control.',
    );
  });

  it('starts a real living-energy deck in single-player mode and waits for the human action', async () => {
    const { commander, cards } = livingDeckCards();
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      gameId: 'living-energy-single-player',
      seed: 'living-energy-single-player',
      seats: ['P1', 'P2', 'P3', 'P4'].map((seat) => livingSeat(seat, commander, cards)),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 12,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    session.start();

    const deadline = Date.now() + 8_000;
    while (
      !sent.some((message) => message.type === 'playerActionRequired') &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const required = sent.find(
      (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
        message.type === 'playerActionRequired',
    );
    expect(required).toBeDefined();
    expect(sent.some((message) => message.type === 'error')).toBe(false);

    const chooser = new RandomDecisionProvider('living-energy-human-check');
    const response = chooser.decide(required!.payload.request);
    session.submitPlayerAction({
      requestId: response.requestId,
      actionId: response.actionId,
      revision: required!.payload.revision,
      ...(response.targets !== undefined ? { targets: response.targets } : {}),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    session.abandon();
    await session.settled();
  }, 12_000);
});
