import type { EngineStep, DecisionResponse } from '@mtg/shared';

/**
 * `@mtg/engine` — the deterministic, authoritative MTG rules engine. Pure TypeScript:
 * no I/O, no network, no framework, and no knowledge that an AI exists (brief §5). It
 * exposes decision points and receives decisions.
 *
 * This is a Phase 0 scaffold. The real engine — game state, seeded RNG, turn structure,
 * priority/APNAP, the stack, state-based actions, combat, Commander rules, mulligans, and
 * legal-action generation — is built in Phase 2 (brief §14.1), directory-by-directory
 * under `src/` (state, turn, stack, sba, combat, actions, commander, rng, log).
 */
export const ENGINE_VERSION = '0.0.0-phase0';

/**
 * The driver shape the orchestrator will loop over (brief §5.1):
 * `advance()` → if `decision`, get a choice → `submit()` → repeat.
 *
 * TODO(phase-2): implement a concrete engine that satisfies this interface.
 */
export interface EngineDriver {
  advance(): EngineStep;
  submit(decision: DecisionResponse): void;
}
