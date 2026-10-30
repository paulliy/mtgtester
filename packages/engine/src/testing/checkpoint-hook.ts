import type { GameContext } from '../state/types';

/**
 * A test-only seam (ADR 0034 decision 8): `flow/game.ts` calls `runCheckpointHook` after
 * state-based actions at each priority checkpoint. Tests and tools install the state-invariant
 * checker here (`testing/invariants.ts`); production installs nothing, and the call is free.
 */
export type CheckpointHook = (ctx: GameContext) => void;

let installed: CheckpointHook | null = null;

/** Install `hook`, or remove the current one with `null`. Returns the one it replaced. */
export function installCheckpointHook(hook: CheckpointHook | null): CheckpointHook | null {
  const previous = installed;
  installed = hook;
  return previous;
}

export function runCheckpointHook(ctx: GameContext): void {
  if (installed !== null) installed(ctx);
}
