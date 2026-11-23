/**
 * The provisional card catalog (H1): which machine-checked cards from the review queue a game
 * may play when it opts in, built once per process from `docs/reviews/compiled-card-queue.json` by `provisional-load.ts`.
 * This module holds the catalog's types and the pure helpers games use, so it reads no files and
 * runs in a browser.
 *
 * An entry is admitted only when all of these hold:
 *   - its status is `compiled-checked` (validator, smoke games and meaning check all passed);
 *   - the patch file's SHA-256 still matches the queue, so the bytes are the ones checked;
 *   - no reviewer rejected it, its cross-check did not find a different behavior, and the fuzz
 *     demotion list does not name it;
 *   - the engine still cannot model the card on its own, and the patch validates today.
 * Anything else is skipped with a reason and reported, never thrown, so one bad entry cannot stop
 * a server. A card with more than one admissible patch plays the first in queue order.
 *
 * The catalog is opt-in everywhere: nothing loads it unless a caller passes `--provisional`, and
 * the engine refuses its definitions in a game that does not set `allowProvisional`.
 */

import type { OracleCard } from '@mtg/shared';
import type { CardDefinition, EnginePlayerConfig, GameConfig } from '@mtg/engine';

export interface ProvisionalAdmission {
  name: string;
  oracleId: string;
  source: string;
  patchSha256: string;
}

export interface ProvisionalSkip {
  name: string;
  oracleId: string;
  source: string;
  reason: string;
}

export interface ProvisionalCatalog {
  /** Provisional definitions by oracle id, each with `trust: 'provisional'`. */
  definitions: Map<string, CardDefinition>;
  admitted: ProvisionalAdmission[];
  skipped: ProvisionalSkip[];
}

/** Is this card playable: modeled by the engine, or admitted to the catalog? */
export function isProvisional(catalog: ProvisionalCatalog | undefined, card: OracleCard): boolean {
  return catalog?.definitions.has(card.oracleId) === true;
}

/**
 * The `GameConfig` fields that opt a game into the provisional cards its decks hold. Empty when
 * no catalog is given or no deck holds one, so such a game's config is unchanged.
 */
export function provisionalGameConfig(
  catalog: ProvisionalCatalog | undefined,
  players: readonly EnginePlayerConfig[],
): Pick<GameConfig, 'allowProvisional' | 'provisionalDefinitions'> {
  if (catalog === undefined || catalog.definitions.size === 0) return {};
  const used = new Map<string, CardDefinition>();
  for (const player of players) {
    const all = [
      ...player.commanders,
      ...player.cards,
      ...(player.companion ? [player.companion] : []),
    ];
    for (const card of all) {
      const def = catalog.definitions.get(card.oracleId);
      if (def !== undefined) used.set(card.oracleId, def);
    }
  }
  if (used.size === 0) return {};
  return { allowProvisional: true, provisionalDefinitions: [...used.values()] };
}

/** The admitted patches a game's decks use, pinned to their bytes for the replay record. */
export function provisionalReplayPins(
  catalog: ProvisionalCatalog | undefined,
  players: readonly EnginePlayerConfig[],
): Array<{ oracleId: string; source: string; patchSha256: string }> {
  const used = new Set(
    (provisionalGameConfig(catalog, players).provisionalDefinitions ?? []).map((d) => d.oracleId),
  );
  return (catalog?.admitted ?? [])
    .filter((entry) => used.has(entry.oracleId))
    .map(({ oracleId, source, patchSha256 }) => ({ oracleId, source, patchSha256 }));
}

/** One line for a CLI or server log: how many queue cards were admitted and why others were not. */
export function describeCatalog(catalog: ProvisionalCatalog): string {
  const reasons = new Map<string, number>();
  for (const skip of catalog.skipped) {
    const key = skip.reason.replace(/:.*$/, '');
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  const parts = [...reasons].map(([reason, n]) => `${n} ${reason}`).join(', ');
  return `provisional cards: ${catalog.definitions.size} admitted${parts ? `; skipped ${parts}` : ''}`;
}
