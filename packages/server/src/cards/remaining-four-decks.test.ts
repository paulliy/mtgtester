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

const deckSlugs = [
  'marchesa-the-black-rose',
  'necron-dynasties',
  'queen-marchesa-queens-gambit',
  'silverquill-influence',
] as const;

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

function deck(slug: (typeof deckSlugs)[number]): { commander: OracleCard; cards: OracleCard[] } {
  const parsed = parsePlaintextDeck(
    readFileSync(resolve('packages/server/fixtures/coverage-decks', `${slug}.txt`), 'utf8'),
  );
  const commanderName = parsed.commanderNames[0];
  if (commanderName === undefined) throw new Error(`${slug} has no commander`);
  return {
    commander: realCard(commanderName),
    cards: parsed.cards.flatMap(({ name, quantity }) =>
      Array.from({ length: quantity }, () => realCard(name)),
    ),
  };
}

function seat(seatId: string, deckData: ReturnType<typeof deck>): SeatSetup {
  const identity = [...deckData.commander.colorIdentity];
  return {
    seat: seatId as 'P1' | 'P2' | 'P3' | 'P4',
    deckSnapshotId: null,
    config: {
      id: seatId as 'P1' | 'P2' | 'P3' | 'P4',
      deckId: `coverage-${seatId}`,
      commanders: [deckData.commander],
      cards: deckData.cards,
    },
    summary: {
      seat: seatId as 'P1' | 'P2' | 'P3' | 'P4',
      deckId: `coverage-${seatId}`,
      label: deckData.commander.name,
      commanderNames: [deckData.commander.name],
      colorIdentity: identity,
      archetypeTag: `${identity.join('') || 'C'} — ${deckData.commander.name}`,
    },
  };
}

describe.skipIf(SKIP)('remaining coverage decks — AI and single-player smoke checks', () => {
  it('models every unique card except the explicit fail-closed backlog', () => {
    const expectedUnmodeled = new Set([
      'Verrak, Warped Sengir',
      'Wandering Archaic // Explore the Vastlands',
      // Audit: incomplete mechanics must not silently simulate approximate card text.
      'Spirit Mantle',
      "Songbirds' Blessing",
      'Promise of Loyalty',
      'Mob Rule',
      'Caged Sun',
      'Hexmark Destroyer',
      'Mystic Forge',
      'Triarch Stalker',
      'Biotransference',
      'The War in Heaven',
      'Out of the Tombs',
      'Szarekh, the Silent King',
      'Trazyn the Infinite',
      // Catalog audit batch 1: retarget authored as copyTargetSpell.
      'Bolt Bend',
      'Deflecting Swat',
      'Cytoplast Manipulator',
      'Flare of Duplication',
      'Twilight Diviner',
      'Siren Stormtamer',
      'Smokestack',
      'Dark Confidant',
      'Kardur, Doomscourge',
      'Mana Sculpt',
      'Vindictive Lich',
      "Angel's Grace",
      'Display of Power',
      'Nighthawk Scavenger',
      'Nils, Discipline Enforcer',
      "Olórin's Searing Light",
      'Reverberate',
      "Tibalt's Trickery",
      'Arcane Lighthouse',
      'Firemane Commando',
      'Armored Skyhunter',
      "Defacing Duskmage // Vandal's Edit",
      'Eiganjo Dynastorian // Replenish',
      'Eriette of the Charmed Apple',
      'Herald of Amity',
      'Intermediate Chirography',
      'Keen Duelist',
      'Tomik, Wielder of Law',
      'Combat Calligrapher',
      'Malakir Rebirth // Malakir Mire',
      'Mangara, the Diplomat',
      'Michiko Konda, Truth Seeker',
      'Valakut Awakening // Valakut Stoneforge',
      'Wear // Tear',
      'Cut a Deal',
      'Chaos Warp',
      'Delirium',
      "Duelist's Heritage",
      'Humble Defector',
      'Teyo, Geometric Tactician',
      'Wishclaw Talisman',
      'Brash Taunter',
      'Breena, the Demagogue',
      'Scheming Symmetry',
      'Shadrix Silverquill',
    ]);
    const observedUnmodeled = new Set<string>();
    for (const slug of deckSlugs) {
      const parsed = parsePlaintextDeck(
        readFileSync(resolve('packages/server/fixtures/coverage-decks', `${slug}.txt`), 'utf8'),
      );
      const names = new Set([...parsed.commanderNames, ...parsed.cards.map((entry) => entry.name)]);
      for (const name of names) {
        const def = interpretCard(realCard(name));
        if (!def.modeled) {
          observedUnmodeled.add(name);
          expect(
            def.unmodeledReasons.length,
            `${slug}: ${name} must fail closed with a reason`,
          ).toBeGreaterThan(0);
          continue;
        }
        expect(def.unmodeledReasons, `${slug}: ${name} still has parser reasons`).toEqual([]);
      }
    }
    expect(observedUnmodeled).toEqual(expectedUnmodeled);
  });

  it.each(deckSlugs)(
    'starts %s in single-player mode and reaches a human decision',
    async (slug) => {
      const deckData = deck(slug);
      const sent: ServerToClientMessage[] = [];
      const session = new MatchSession({
        gameId: `coverage-${slug}-single-player`,
        seed: `coverage-${slug}-single-player`,
        seats: ['P1', 'P2', 'P3', 'P4'].map((seatId) => seat(seatId, deckData)),
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
        !sent.some((message) => message.type === 'error') &&
        Date.now() < deadline
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      const required = sent.find(
        (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          message.type === 'playerActionRequired',
      );
      expect(sent.some((message) => message.type === 'error')).toBe(false);
      expect(required).toBeDefined();

      const response = new RandomDecisionProvider(`coverage-${slug}-human-check`).decide(
        required!.payload.request,
      );
      session.submitPlayerAction({
        requestId: response.requestId,
        actionId: response.actionId,
        revision: required!.payload.revision,
        ...(response.targets !== undefined ? { targets: response.targets } : {}),
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      session.abandon();
      await session.settled();
    },
    12_000,
  );
});
