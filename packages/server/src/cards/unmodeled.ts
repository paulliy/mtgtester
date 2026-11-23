/**
 * The part of the card report the setup preview needs, kept free of Node and Bun modules so the
 * session code that builds previews can run in the browser (ADR 0053, `bundle-guard.test.ts`):
 * the Oracle hash a card is pinned by, and which of a deck's cards the engine does not model.
 */

import { interpretCard } from '@mtg/engine';
import { sha256Hex, type OracleCard, type UnmodeledCard } from '@mtg/shared';
import { canonicalOracle } from './coverage-contract';
import { isProvisional, type ProvisionalCatalog } from './provisional';

/** SHA-256 of the card's canonical Oracle record, the hash lab scenarios and the ledger pin. */
export function oracleSha256(card: OracleCard): string {
  return sha256Hex(canonicalOracle(card));
}

/**
 * The distinct cards of a deck the engine's interpreter does not model on its own, in name order:
 * `unsupported` where nothing else covers them, `provisional` where the server admitted a
 * machine-checked definition (ADR 0050). A fully modeled deck gives an empty list.
 */
export function describeUnmodeled(
  cards: readonly OracleCard[],
  provisional: ProvisionalCatalog | undefined,
): UnmodeledCard[] {
  const byName = new Map<string, UnmodeledCard>();
  for (const card of cards) {
    if (byName.has(card.name) || interpretCard(card).modeled) continue;
    byName.set(card.name, {
      name: card.name,
      oracleSha256: oracleSha256(card),
      status: isProvisional(provisional, card) ? 'provisional' : 'unsupported',
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
