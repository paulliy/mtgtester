import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  PlayerView,
} from '@mtg/shared';
import type { CardKnowledge } from './card-knowledge';
import type { CombatSearchOptions } from './combat-search';
import type { DiplomacyPlay } from './diplomacy/play';
import type { PolicyFix } from './fixes';
import { decideScored, type EvaluateOptions, type ScoredDecision } from './evaluate';
import { Rng, type RandomSource } from './rng';

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
export interface HeuristicProviderOptions {
  /**
   * Bounds for ADR 0024's combat search, and the switch that turns it off. Omitted everywhere in
   * normal play — the sweep that tunes those bounds is the only caller, and it needs two
   * differently-configured seats inside one game.
   */
  combatSearch?: CombatSearchOptions;
  /** Table diplomacy for this seat (ADR 0035). Omitted, the bot plays exactly as before. */
  diplomacy?: DiplomacyPlay;
  /** Card traits from the IR, by name (ADR 0039). */
  knowledge?: CardKnowledge;
  /** The strategist's current knobs for this seat, read at every decision (ADR 0039). */
  steering?: () => BotSteering | undefined;
  /** Score with the pre-ADR 0039 policy, for league comparisons only. */
  legacy?: boolean;
  /**
   * ADR 0043's policy fixes to play with. Omitted is `DEFAULT_POLICY_FIXES`, the production bot;
   * `[]` is the bot as it was before them (bot-bench's table and `heuristic-plain`).
   */
  fixes?: readonly PolicyFix[];
}

export class HeuristicDecisionProvider implements DecisionProviderLike {
  private readonly rng: RandomSource;
  private readonly viewOf: () => PlayerView;
  private readonly opts: HeuristicProviderOptions;
  private turnSeen = -1;
  private readonly activationsThisTurn = new Map<string, number>();
  private mulligansTaken = 0;

  /**
   * Constructed with a view accessor rather than a fixed `PlayerView`: scoring needs the
   * deciding player's current life and board every time, and re-fetching it per decision (via
   * `engine.view(seat)`) is cheap and always current.
   *
   * `seed` is a string for today's seeded `Rng` (every benchmark, CLI and tester call site), or
   * an injected `{ nextInt }` source: the table server passes a keyed stream (ADR 0031 decision 4).
   */
  constructor(
    seed: string | RandomSource,
    viewOf: () => PlayerView,
    opts: HeuristicProviderOptions = {},
  ) {
    this.rng = typeof seed === 'string' ? new Rng(seed) : seed;
    this.viewOf = viewOf;
    this.opts = opts;
  }

  decide(request: DecisionRequest): DecisionResponse {
    return this.decideScored(request).response;
  }

  /**
   * `decide`, also returning the ranking, for the escalate-when-unsure check (ADR 0039). With
   * `record` false the answer is not noted, for a caller that may still hand the decision to
   * someone else and will `record` whatever is finally chosen.
   */
  decideScored(request: DecisionRequest, record = true): ScoredDecision {
    this.syncTurn(request);
    const steering = this.opts.steering?.();
    const options: EvaluateOptions = {
      repeatCount: (action) => {
        const key = activationKey(action);
        return key === null ? 0 : (this.activationsThisTurn.get(key) ?? 0);
      },
      mulligansTaken: this.mulligansTaken,
      ...(this.opts.combatSearch !== undefined ? { combatSearch: this.opts.combatSearch } : {}),
      ...(this.opts.diplomacy !== undefined ? { diplomacy: this.opts.diplomacy } : {}),
      ...(this.opts.knowledge !== undefined ? { knowledge: this.opts.knowledge } : {}),
      ...(steering !== undefined ? { steering } : {}),
      ...(this.opts.legacy === true ? { legacy: true } : {}),
      ...(this.opts.fixes !== undefined ? { fixes: this.opts.fixes } : {}),
    };
    const scored = decideScored(request, this.viewOf(), this.rng, options);
    if (record) this.record(request, scored.response);
    return scored;
  }

  private syncTurn(request: DecisionRequest): void {
    if (request.turn !== this.turnSeen) {
      this.turnSeen = request.turn;
      this.activationsThisTurn.clear();
    }
  }

  /**
   * Note a decision this seat made, whoever made it: the repeat damper and the mulligan count
   * must see the model's answers too when the bot shares a seat with an escalating tactician.
   */
  record(request: DecisionRequest, response: DecisionResponse): void {
    this.syncTurn(request);
    const chosen = request.legalActions.find((a) => a.id === response.actionId);
    if (chosen?.type === 'mulligan') this.mulligansTaken++;
    const key = chosen === undefined ? null : activationKey(chosen);
    if (key !== null) {
      this.activationsThisTurn.set(key, (this.activationsThisTurn.get(key) ?? 0) + 1);
    }
  }
}
