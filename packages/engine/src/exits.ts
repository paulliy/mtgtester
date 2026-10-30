import { EngineInvariantError } from './errors';
import type { GameContext } from './state/types';

/**
 * Why an op may exit without acting (ADR 0034 decision 4): a closed list, each a rules-sanctioned
 * outcome with the rule that sanctions it. A guard that is none of these is either a bug the
 * engine should fail on (`invariant`) or a missing reason to add here with its rule.
 */
export const NOOP_REASONS = {
  targetIllegal:
    'CR 608.2b: a target that is illegal as the ability resolves is not affected by it',
  objectGone: 'CR 400.7: an object that changed zones is a new object the effect does not see',
  nothingQualifies: 'CR 609.3: the effect does as much as it can, and nothing qualifies',
} as const;

export type NoopReason = keyof typeof NOOP_REASONS;

/**
 * Record a rules-sanctioned early exit at `site` (a literal string naming the code). It writes only
 * to the test-only diagnostics sink: no RNG, no game event, no debug log entry, and `detail` is
 * called only when a sink exists. Without one it does nothing.
 */
export function noop(
  ctx: GameContext,
  site: string,
  reason: NoopReason,
  detail?: () => string,
): void {
  ctx.diagnostics?.noop(site, reason, detail?.());
}

/**
 * Fail where a validated card definition cannot reach: an authoring or engine bug, never a rules
 * outcome. Use it in place of a guard only with a written argument that validation makes the
 * guard unreachable, and a test that reaches it through malformed IR. `Engine.advance` halts the
 * game naming `site`, or rethrows under `strictInvariants`.
 */
export function invariant(site: string, reason: string): never {
  throw new EngineInvariantError(site, reason);
}

/** Note the op `executeAbility` is about to run, for the diagnostics sink. */
export function enterOp(ctx: GameContext, card: string, op: string): void {
  ctx.diagnostics?.enterOp(card, op);
}
