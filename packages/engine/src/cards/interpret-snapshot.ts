/**
 * A canonical serialization of `interpretCard`'s output over a fixed card set.
 *
 * Same purpose as `overrides/snapshot.ts`, for the other half of the pipeline: a refactor that
 * moves interpret.ts's hand-authored special cases onto the shared builders (`cards/templates.ts`)
 * needs proof it left the produced `CardDefinition`s unchanged. `urdragon-coverage.test.ts` already
 * pins which card NAMES model; this pins the definition BODIES, for the same committed, CI-safe
 * 93-card fixture (`tests/fixtures/urdragon-oracle.json`) — no gitignored bulk data required.
 *
 * `interpretCard` calls `applyOverride` internally before returning, so this snapshot is the
 * definition the engine actually uses, not a pre-override intermediate.
 *
 * Object keys are sorted (immaterial to any consumer — `CardDefinition` fields are read by name);
 * array order is preserved (load-bearing: it is the target-slot index and the effect resolution
 * order).
 */

import type { OracleCard } from '@mtg/shared';
import { interpretCard } from './interpret';

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
  return out;
}

/** A definition with its object keys sorted, as the snapshots serialize it. */
export function canonicalDefinition(definition: unknown): unknown {
  return canonical(definition);
}

/** `interpretCard(card)` for every card in `cards`, as canonical JSON with a trailing newline. */
export function interpretSnapshot(cards: OracleCard[]): string {
  const defs = [...cards]
    .sort((a, b) => a.oracleId.localeCompare(b.oracleId))
    .map((card) => canonical(interpretCard(card)));
  return `${JSON.stringify(defs, null, 2)}\n`;
}
