/**
 * The provisional trust tier (H1): turning a machine-checked patch from the review queue into a
 * card definition a game may use when it opts in.
 *
 * A provisional definition is built exactly as the card compiler checked it (`applyPatch` in
 * `scripts/card-compiler/lib.ts`): the patch is registered as an `'append'` override for the
 * duration of one interpretation, the merged definition is validated, and the registry is put
 * back as it was. Nothing stays registered, so a game that does not opt in never sees the patch,
 * and `interpretCard` keeps answering as before for every caller.
 *
 * Pure: no I/O. The server reads the queue and the patch files and hands the data in.
 */

import type { OracleCard, OracleId } from '@mtg/shared';
import type { CardDefinition } from './definition';
import { interpretCard } from './interpret';
import { validateCardDefinition, validateOverrideDefinition } from './authoring-validation';
import {
  getOverride,
  registerOverride,
  unregisterOverride,
  type CardOverride,
} from './overrides/index';

/** One checked patch, as the review queue's patch file stores it. */
export interface ProvisionalPatch {
  /** The Oracle lines the patch implements, verbatim from the card's `unmodeledReasons`. */
  handledLines: string[];
  def: Partial<CardDefinition>;
  /** The patch's origin, e.g. `compiler@haiku-worker` or `xmage@31ede542`. */
  source: string;
}

export type ProvisionalResult =
  | { ok: true; definition: CardDefinition }
  | {
      ok: false;
      /** `modeled`: the interpreter models the card without the patch, so it is not needed. */
      kind: 'modeled' | 'unsupported' | 'invalid' | 'unmodeled';
      issues: string[];
    };

/**
 * Fields a patch may not set: Oracle data owns a card's identity, and only this module decides
 * trust. Mirrors the compiler's `IDENTITY_FIELDS`, plus the trust fields.
 */
const FORBIDDEN_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'oracleId',
  'scryfallId',
  'name',
  'typeLine',
  'supertypes',
  'types',
  'subtypes',
  'colors',
  'colorIdentity',
  'manaCost',
  'hasUnsupportedCost',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'modeled',
  'unmodeledReasons',
  'trust',
  'trustSource',
]);

/**
 * Build the provisional definition of `card` from `patch`, or say why not. Never throws on bad
 * data: a patch that fails validation is reported, so one bad queue entry cannot stop a server.
 */
export function interpretProvisional(card: OracleCard, patch: ProvisionalPatch): ProvisionalResult {
  const existing = getOverride(card.oracleId as OracleId);
  if (existing?.unsupportedReason !== undefined) {
    // An explicit "this card is known wrong" declaration outranks any unreviewed patch.
    return { ok: false, kind: 'unsupported', issues: [existing.unsupportedReason] };
  }
  const baseline = interpretCard(card);
  if (baseline.modeled) {
    // The interpreter has learned the card since the patch was checked. Appending the patch now
    // would double an ability, so the reviewed path wins.
    return { ok: false, kind: 'modeled', issues: [] };
  }

  const forbidden = Object.keys(patch.def).filter((key) => FORBIDDEN_PATCH_FIELDS.has(key));
  if (forbidden.length > 0)
    return {
      ok: false,
      kind: 'invalid',
      issues: [`the patch may not set: ${forbidden.join(', ')}`],
    };

  const override: CardOverride = {
    oracleId: card.oracleId as OracleId,
    name: card.name,
    handledLines: patch.handledLines,
    def: patch.def,
    compose: 'append',
  };
  const early = validateOverrideDefinition(override);
  if (early.length > 0)
    return {
      ok: false,
      kind: 'invalid',
      issues: early.map((issue) => `${issue.path}: ${issue.message}`),
    };

  if (existing !== undefined) unregisterOverride(override.oracleId);
  registerOverride(override);
  let definition: CardDefinition;
  try {
    definition = interpretCard(card);
  } catch (error) {
    return { ok: false, kind: 'invalid', issues: [`interpretation threw: ${String(error)}`] };
  } finally {
    unregisterOverride(override.oracleId);
    if (existing !== undefined) registerOverride(existing);
  }

  if (!definition.modeled)
    return { ok: false, kind: 'unmodeled', issues: [...definition.unmodeledReasons] };
  const issues = validateCardDefinition(definition).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
  if (issues.length > 0) return { ok: false, kind: 'invalid', issues };
  return {
    ok: true,
    definition: { ...definition, trust: 'provisional', trustSource: patch.source },
  };
}
