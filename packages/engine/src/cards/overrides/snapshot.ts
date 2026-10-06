/**
 * A canonical serialization of the whole override registry.
 *
 * This exists so a refactor of the *authoring* layer can be proven to leave the authored DATA
 * unchanged. The repo's other signals cannot do that: `docs/modelled-cards.md` compares card
 * names, and `determinism.test.ts` compares a run against itself, so both stay green through a
 * change that silently rewrites a definition's body.
 *
 * Two rules make the comparison the right one:
 *
 * - **Object keys are sorted.** `applyOverride` merges with a shallow spread, which is
 *   key-order-insensitive, and a builder legitimately emits fields in a different order than the
 *   literal it replaced. Only the sorted projection is the semantic contract.
 * - **Array order is preserved.** It is load-bearing: `Effect[]` order decides resolution order,
 *   and a `TargetSpec`'s position IS the slot index every `EffectRef` number points at.
 *
 * An explicitly-`undefined` property is recorded as a sentinel rather than dropped, because a
 * spread copies own enumerable keys regardless of value: `{ foo: undefined }` overwrites an
 * interpreted `foo` while omitting the key preserves it. Those are not the same override.
 */

import { listOverrides } from './index';

const UNDEFINED = '<undefined>';

function canonical(value: unknown): unknown {
  if (value === undefined) return UNDEFINED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
  return out;
}

/** The registry as canonical JSON, with a trailing newline. */
export function overrideSnapshot(): string {
  const entries = listOverrides().map((o) => ({
    oracleId: o.oracleId,
    name: o.name,
    // Sorted: which lines an override claims is a set — the order they are listed in does not
    // change which reasons `applyOverride` clears.
    handledLines: [...o.handledLines].sort(),
    def: canonical(o.def),
    // An `'append'` override extends the interpreted ability lists instead of replacing them, so
    // the same `def` means different behavior with and without it.
    ...(o.compose === undefined ? {} : { compose: o.compose }),
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}
