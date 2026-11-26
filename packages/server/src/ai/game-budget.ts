/**
 * The per-game spending cap and per-call deadlines for model seats at a table (ADR 0055
 * decisions 4 to 6).
 *
 * One `GameAiBudget` belongs to one game and is shared by every model seat in it, strategist and
 * tactician alike. `limitedClient` wraps a seat's client so that:
 *
 * - a call is refused before it is sent once the game's budget has stopped, and the AI provider
 *   then answers with its heuristic fallback, which costs nothing;
 * - every physical attempt is charged: OpenRouter's reported cost when there is one, otherwise the
 *   price-table estimate (`pricing.ts`), so the cap works on the Anthropic API too;
 * - each call has a hard wall-clock deadline, retries included, through the abort signal the
 *   client already honors.
 *
 * The budget also stops when the provider says the key itself is out of credit, over its spend
 * limit, or no longer valid, so the remaining decisions go straight to the bot instead of each
 * paying a failed call first.
 */

import type { DecisionRequest } from '@mtg/shared';
import type { AiAttemptObserver, AiClient, AiNetworkAttempt, CallMeta } from './client';
import type { AiPrompt } from './context';
import { estimateCostUsd } from './pricing';

export type BudgetStop = 'cap' | 'key';

/** Thrown, before any request is sent, by a client whose game budget has stopped. */
export class BudgetExhaustedError extends Error {
  constructor(readonly reason: BudgetStop) {
    super(
      reason === 'cap'
        ? 'the game reached its AI spending cap'
        : 'the AI provider refused the key (credit, spend limit or authentication)',
    );
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Whether an attempt's failure is the key's own limit rather than an ordinary error. A plain 429
 * rate limit is not: it passes. Authentication failures are, because no later call can succeed.
 */
export function isKeyLimitFailure(
  attempt: Pick<AiNetworkAttempt, 'status' | 'error' | 'rawResponse'>,
): boolean {
  if (attempt.status !== 'http_error') return false;
  // The client records `HTTP <status>` as the error and the provider's body as the raw response.
  if (/\bHTTP (401|402|403)\b/.test(attempt.error ?? '')) return true;
  return /credit balance|insufficient (credit|funds|balance)|billing|spend(ing)? limit|usage limit|payment required|authentication_error/i.test(
    attempt.rawResponse ?? '',
  );
}

export class GameAiBudget {
  private spent = 0;
  private stoppedFor: BudgetStop | null = null;
  /** Attempts that reported no cost and could not be priced (no tokens, or no price row). */
  unpricedAttempts = 0;
  /** Called once, when the budget stops. */
  onStop?: (reason: BudgetStop, spentUsd: number) => void;
  /** Calls in flight, which a stop aborts so no retry inside them spends past the cap. */
  private readonly stopListeners = new Set<() => void>();

  constructor(readonly maxUsd: number) {
    if (!(maxUsd > 0)) throw new RangeError(`a game AI budget must be positive, got ${maxUsd}`);
  }

  get spentUsd(): number {
    return this.spent;
  }

  get stopped(): BudgetStop | null {
    return this.stoppedFor;
  }

  /** Throws `BudgetExhaustedError` once the budget has stopped. */
  check(): void {
    if (this.stoppedFor !== null) throw new BudgetExhaustedError(this.stoppedFor);
  }

  /** Charge one physical attempt, and stop on the cap or on a key-limit failure. */
  charge(attempt: AiNetworkAttempt): void {
    const cost = attempt.usage.costUsd ?? estimateCostUsd(attempt.requestedModel, attempt.usage);
    if (cost === undefined) this.unpricedAttempts++;
    else this.spent += cost;
    if (isKeyLimitFailure(attempt)) this.stop('key');
    else if (this.spent >= this.maxUsd) this.stop('cap');
  }

  stop(reason: BudgetStop): void {
    if (this.stoppedFor !== null) return;
    this.stoppedFor = reason;
    for (const listener of [...this.stopListeners]) listener();
    this.onStop?.(reason, this.spent);
  }

  /** Run `listener` when the budget stops; returns the unsubscribe. */
  whenStopped(listener: () => void): () => void {
    this.stopListeners.add(listener);
    return () => {
      this.stopListeners.delete(listener);
    };
  }
}

/**
 * A client that answers to `budget` and gives up after `deadlineMs` (retries and model fallback
 * included). The deadline aborts the call; the AI provider treats that like any failed call and
 * answers with its heuristic fallback.
 *
 * Two things hold even when the inner client is slow to notice its signal:
 *
 * - The call settles when the deadline passes, not when the inner client next checks the signal.
 *   (Its rate-limit wait sleeps 60 s without watching it.)
 * - When the game's budget stops, from this seat or any other, every call in flight is aborted, so
 *   the inner client's own retries send nothing more: it checks the signal before each attempt.
 */
export function limitedClient(inner: AiClient, budget: GameAiBudget, deadlineMs: number): AiClient {
  let outer: AiAttemptObserver | undefined;
  const observe: AiAttemptObserver = async (attempt) => {
    budget.charge(attempt);
    await outer?.(attempt);
  };
  inner.setAttemptObserver?.(observe);
  return {
    get activeModel() {
      return inner.activeModel;
    },
    setAttemptObserver(observer) {
      outer = observer;
    },
    async requestDecision(
      prompt: AiPrompt,
      request: DecisionRequest,
      signal?: AbortSignal,
    ): Promise<{ response: DecisionResponseOf; meta: CallMeta }> {
      budget.check();
      const stopped = new AbortController();
      const unsubscribe = budget.whenStopped(() => {
        stopped.abort(new BudgetExhaustedError(budget.stopped ?? 'cap'));
      });
      const combined = AbortSignal.any([
        stopped.signal,
        AbortSignal.timeout(deadlineMs),
        ...(signal === undefined ? [] : [signal]),
      ]);
      try {
        return await new Promise((resolve, reject) => {
          const onAbort = (): void => {
            reject(
              combined.reason instanceof Error ? combined.reason : new Error('AI call aborted'),
            );
          };
          if (combined.aborted) {
            onAbort();
            return;
          }
          combined.addEventListener('abort', onAbort, { once: true });
          // A late settle after the abort is ignored: the promise has already rejected.
          inner.requestDecision(prompt, request, combined).then(resolve, reject);
        });
      } finally {
        unsubscribe();
      }
    },
  };
}

type DecisionResponseOf = Awaited<ReturnType<AiClient['requestDecision']>>['response'];
