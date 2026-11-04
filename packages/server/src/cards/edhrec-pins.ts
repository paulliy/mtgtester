/**
 * Offline pins for the EDHREC coverage plan (decision D3, Phase 1 step 7).
 *
 * The ready list spans about 9,000 ranked cards, far more than the pinned coverage fixture, and its
 * Oracle text came from the gitignored Scryfall bank. `bun run coverage:pin` copies the Oracle
 * records of every ready-list card (modeled, or one unparsed line away) from the bank into
 * `packages/server/fixtures/edhrec-pinned-oracle.json`. Pins are append-only: a later run adds
 * cards and refreshes changed records, and never drops one. `edhrec-modeled.json` records which
 * pinned cards model, so a test fails offline when a modeled card regresses or when a newly
 * modeled card has not been recorded.
 */
import { createHash } from 'node:crypto';
import type { OracleCard } from '@mtg/shared';
import { measureCoverage } from './coverage';
import type { EdhrecRanking } from './edhrec-ranking';
import { readiness } from './edhrec-ranking';
import type { OracleIndex } from './oracle-index';

export const PINNED_ORACLE_PATH = 'packages/server/fixtures/edhrec-pinned-oracle.json';
export const MODELED_RATCHET_PATH = 'packages/server/fixtures/edhrec-modeled.json';

/** One pinned card: its ranking position and its Oracle record as the bank projected it. */
export interface PinnedCard {
  rank: number;
  card: OracleCard;
}

export interface ModeledRatchet {
  /** SHA-256 of the pinned fixture the modeled list was computed from. */
  fixtureSha256: string;
  pinned: number;
  /** Names of the pinned cards that model, in rank order. */
  modeled: string[];
}

/** The ready-list cards of the ranking, resolved in the bank, merged into the existing pins. */
export function pinReadyList(
  ranking: EdhrecRanking,
  index: OracleIndex,
  existing: readonly PinnedCard[],
): { pins: PinnedCard[]; added: string[]; changed: string[]; unresolved: string[] } {
  const byName = new Map(existing.map((pin) => [pin.card.name, pin]));
  const added: string[] = [];
  const changed: string[] = [];
  const unresolved: string[] = [];
  ranking.cards.forEach(([name], position) => {
    const card = index.resolve(name);
    if (card === null) {
      unresolved.push(name);
      return;
    }
    const before = byName.get(card.name);
    if (before === undefined) {
      if (readiness(measureCoverage([{ name: 'EDHREC', cards: [card] }]).cards[0]!) === null)
        return;
      added.push(card.name);
    } else if (JSON.stringify(before.card) !== JSON.stringify(card)) changed.push(card.name);
    byName.set(card.name, { rank: position + 1, card });
  });
  const pins = [...byName.values()].sort((a, b) => a.rank - b.rank);
  return { pins, added, changed, unresolved };
}

/** The pinned fixture as written: one card per line, so a diff shows exactly which cards changed. */
export function renderPins(pins: readonly PinnedCard[]): string {
  return `[\n${pins.map((pin) => JSON.stringify(pin)).join(',\n')}\n]\n`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The ratchet computed from the pinned fixture's text: which pinned cards model today. */
export function modeledRatchet(fixtureText: string): ModeledRatchet {
  const pins = JSON.parse(fixtureText) as PinnedCard[];
  const report = measureCoverage(pins.map((pin) => ({ name: pin.card.name, cards: [pin.card] })));
  const modeled = new Set(
    report.cards.filter((card) => card.modeled && card.reasons.length === 0).map((c) => c.name),
  );
  return {
    fixtureSha256: sha256(fixtureText),
    pinned: pins.length,
    modeled: pins.map((pin) => pin.card.name).filter((name) => modeled.has(name)),
  };
}

/** How the recorded ratchet and the current one differ: regressions fail, so do new models. */
export function ratchetDrift(
  recorded: ModeledRatchet,
  current: ModeledRatchet,
): { regressed: string[]; newlyModeled: string[]; fixtureChanged: boolean } {
  const now = new Set(current.modeled);
  const then = new Set(recorded.modeled);
  return {
    regressed: recorded.modeled.filter((name) => !now.has(name)),
    newlyModeled: current.modeled.filter((name) => !then.has(name)),
    fixtureChanged: recorded.fixtureSha256 !== current.fixtureSha256,
  };
}
