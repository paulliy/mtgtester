import type { DecisionRequest, DecisionResponse, LegalAction, PlayerView } from '@mtg/shared';
import { decide } from './evaluate';
import { Rng } from './rng';

/**
 * Structural match for `packages/engine/src/providers/providers.ts`'s `DecisionProvider`
 * (`decide(request): DecisionResponse`) — not imported, so `@mtg/bot` keeps its single
 * dependency on `@mtg/shared` (ADR 0023 item 1). TypeScript is structurally typed, so
 * `HeuristicDecisionProvider` satisfies that interface without the import; every engine call
 * site that currently accepts a `DecisionProvider` accepts this too.
 */
export interface DecisionProviderLike {
  decide(request: DecisionRequest): DecisionResponse;
}

/** Identifies "the same ability on the same permanent" for the repeat-activation damper. */
function activationKey(action: LegalAction): string | null {
  if (action.interaction?.kind !== 'source' || action.interaction.abilityIndex === undefined) {
    return null;
  }
  return `${action.interaction.sourceId}#${action.interaction.abilityIndex}`;
}

/**
 * A non-random, non-LLM opponent (ADR 0023). Scores every legal action instead of picking
 * uniformly, so it advances the board instead of drifting into pathological self-harm — see
 * `evaluate.ts` for the scoring and `veto.ts` for the hard floor that backs it up.
 *
 * Phase 1 wires this in only as the LLM path's fallback (`@mtg/server`'s `escalateOrFallback`,
 * used directly through `decide()`/`evaluate()` rather than this class). This class is the
 * shape Phase 2 drops into the live-opponent call sites `RandomDecisionProvider` currently
 * occupies (`session.ts`, `pool.ts`, `play-decks.ts`), where the repeat-activation damper below
 * actually matters: it persists across every decision this instance answers.
 */
export class HeuristicDecisionProvider implements DecisionProviderLike {
  private readonly rng: Rng;
  private readonly viewOf: () => PlayerView;
  private turnSeen = -1;
  private readonly activationsThisTurn = new Map<string, number>();

  /**
   * Constructed with a view accessor rather than a fixed `PlayerView`: scoring needs the
   * deciding player's current life and board every time, and re-fetching it per decision (via
   * `engine.view(seat)`) is cheap and always current.
   */
  constructor(seed: string, viewOf: () => PlayerView) {
    this.rng = new Rng(seed);
    this.viewOf = viewOf;
  }

  decide(request: DecisionRequest): DecisionResponse {
    if (request.turn !== this.turnSeen) {
      this.turnSeen = request.turn;
      this.activationsThisTurn.clear();
    }

    const response = decide(request, this.viewOf(), this.rng, {
      repeatCount: (action) => {
        const key = activationKey(action);
        return key === null ? 0 : (this.activationsThisTurn.get(key) ?? 0);
      },
    });

    const chosen = request.legalActions.find((a) => a.id === response.actionId);
    const key = chosen === undefined ? null : activationKey(chosen);
    if (key !== null) {
      this.activationsThisTurn.set(key, (this.activationsThisTurn.get(key) ?? 0) + 1);
    }
    return response;
  }
}
