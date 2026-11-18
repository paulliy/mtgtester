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
 *
 * It also records a fingerprint of each modeled card's definition. "Still models" says nothing
 * about what a card does: a grammar change can drop a clause from a card, or point its target
 * somewhere else, and leave it modeled. The definition snapshots cover about a thousand pinned
 * cards; the fingerprints cover every modeled card in the pool, at one short hash each.
 */
import { createHash } from 'node:crypto';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
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
  /**
   * `definitionFingerprint` of every modeled card, by name. Absent from a ratchet recorded before
   * fingerprints existed, which then only checks which cards model.
   */
  fingerprints?: Record<string, string>;
}

/** A definition as JSON with its keys sorted at every level, so key order never changes it. */
export function canonicalDefinition(definition: unknown): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(sortKeys(definition));
}

/**
 * A short hash of everything a card's definition says, descriptions included: the text a player
 * and the AI read is part of what the card does at the table. 64 bits is enough to tell two
 * definitions of one card apart; nothing compares fingerprints across cards.
 */
export function definitionFingerprint(definition: unknown): string {
  return sha256(canonicalDefinition(definition)).slice(0, 16);
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
  const modeledPins = pins.filter((pin) => modeled.has(pin.card.name));
  return {
    fixtureSha256: sha256(fixtureText),
    pinned: pins.length,
    modeled: modeledPins.map((pin) => pin.card.name),
    fingerprints: Object.fromEntries(
      modeledPins.map((pin) => [pin.card.name, definitionFingerprint(interpretCard(pin.card))]),
    ),
  };
}

export interface RatchetDrift {
  regressed: string[];
  newlyModeled: string[];
  /** Cards that modeled then and model now, with a different definition. */
  behaviorChanged: string[];
  fixtureChanged: boolean;
}

/**
 * How the recorded ratchet and the current one differ: regressions fail, so do new models, and so
 * does a card that still models with a changed definition.
 */
export function ratchetDrift(recorded: ModeledRatchet, current: ModeledRatchet): RatchetDrift {
  const now = new Set(current.modeled);
  const then = new Set(recorded.modeled);
  const before = recorded.fingerprints;
  const after = current.fingerprints ?? {};
  return {
    regressed: recorded.modeled.filter((name) => !now.has(name)),
    newlyModeled: current.modeled.filter((name) => !then.has(name)),
    behaviorChanged:
      before === undefined
        ? []
        : recorded.modeled.filter((name) => now.has(name) && before[name] !== after[name]),
    fixtureChanged: recorded.fixtureSha256 !== current.fixtureSha256,
  };
}

/** True when nothing drifted, and the recorded ratchet carries fingerprints to check against. */
export function ratchetHolds(recorded: ModeledRatchet, drift: RatchetDrift): boolean {
  return (
    recorded.fingerprints !== undefined &&
    drift.regressed.length === 0 &&
    drift.newlyModeled.length === 0 &&
    drift.behaviorChanged.length === 0 &&
    !drift.fixtureChanged
  );
}

/**
 * Every modeled pinned card's canonical definition, one `name<TAB>json` line each. Fingerprints
 * say that a card changed, not how; dump at the base commit and at the head and diff the two
 * files to see the change itself.
 */
export function dumpDefinitions(fixtureText: string): string {
  const pins = JSON.parse(fixtureText) as PinnedCard[];
  const lines: string[] = [];
  for (const pin of pins) {
    const definition = interpretCard(pin.card);
    if (definition.modeled) lines.push(`${pin.card.name}\t${canonicalDefinition(definition)}`);
  }
  return `${lines.join('\n')}\n`;
}
