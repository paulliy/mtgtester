import type { AsyncDecisionProvider } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  SubmitPlayerActionPayload,
} from '@mtg/shared';

function abilityKey(action: LegalAction): string | null {
  const interaction = action.interaction;
  if (
    action.type !== 'activateAbility' ||
    interaction?.kind !== 'source' ||
    interaction.sourceCardId === undefined ||
    interaction.abilityIndex === undefined
  ) {
    return null;
  }
  return `${interaction.sourceCardId}:${interaction.abilityIndex}`;
}

function isPass(action: LegalAction | undefined): boolean {
  return (
    action?.type === 'pass' ||
    action?.type === 'passAndYieldTurn' ||
    action?.type === 'yieldToAbility'
  );
}

/**
 * Bot-side equivalent of a player yielding an optional ability. Once a bot passes while a
 * sacrifice-costed activation is available, it stops reconsidering that activation every turn.
 * The original legal action ids remain intact, so the engine still validates every response.
 */
export class PersistentAbilityYieldProvider implements AsyncDecisionProvider {
  private readonly ignored = new Set<string>();

  constructor(private readonly inner: AsyncDecisionProvider) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const visibleRequest: DecisionRequest = {
      ...request,
      legalActions: request.legalActions.filter((action) => {
        const key = abilityKey(action);
        return key === null || !this.ignored.has(key);
      }),
    };
    const response = await this.inner.decide(visibleRequest);
    const chosen = request.legalActions.find((action) => action.id === response.actionId);
    if (request.decisionType === 'priority' && isPass(chosen)) {
      for (const action of request.legalActions) {
        const key = abilityKey(action);
        const costs = action.data?.['abilityCosts'];
        if (
          key !== null &&
          Array.isArray(costs) &&
          costs.some(
            (cost) =>
              typeof cost === 'object' &&
              cost !== null &&
              (cost as { kind?: unknown }).kind === 'sacrificeSelf',
          )
        ) {
          this.ignored.add(key);
        }
      }
    }
    return response;
  }

  ignoredKeys(): readonly string[] {
    return [...this.ignored];
  }
}

export interface PendingHumanDecision {
  request: DecisionRequest;
  revision: number;
}

/**
 * Untimed decision provider for one human seat. Only a response matching both the request id
 * and the board revision can release the engine.
 */
export class HumanDecisionProvider implements AsyncDecisionProvider {
  private pending: (PendingHumanDecision & { resolve(response: DecisionResponse): void }) | null =
    null;

  constructor(
    private readonly revision: () => number,
    private readonly onRequired: (pending: PendingHumanDecision) => void,
  ) {}

  decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (this.pending !== null) {
      return Promise.reject(new Error('human provider received a second concurrent decision'));
    }
    const revision = this.revision();
    return new Promise<DecisionResponse>((resolve) => {
      this.pending = { request, revision, resolve };
      this.onRequired({ request, revision });
    });
  }

  current(): PendingHumanDecision | null {
    if (this.pending === null) return null;
    return { request: this.pending.request, revision: this.pending.revision };
  }

  submit(payload: SubmitPlayerActionPayload): string | null {
    const pending = this.pending;
    if (pending === null) return 'No human action is currently required.';
    if (payload.requestId !== pending.request.requestId) return 'That decision is stale.';
    if (payload.revision !== pending.revision) return 'The board changed; choose again.';
    const action = pending.request.legalActions.find(
      (candidate) => candidate.id === payload.actionId,
    );
    if (action === undefined) return 'That action is not on the current legal menu.';
    const slots = action.targets ?? [];
    const suppliedTargets = payload.targets ?? [];
    const expectedSlots = new Set(slots.map((slot) => slot.slot));
    const seenSlots = new Set<number>();
    for (const target of suppliedTargets) {
      if (!expectedSlots.has(target.slot)) return `Target slot ${target.slot + 1} is not expected.`;
      if (seenSlots.has(target.slot)) return `Target slot ${target.slot + 1} was submitted twice.`;
      seenSlots.add(target.slot);
    }
    for (const slot of slots) {
      const choice = suppliedTargets.find((target) => target.slot === slot.slot)?.choice;
      if (choice === undefined && slot.options.length > 1) {
        return `Target ${slot.slot + 1} still needs a choice.`;
      }
      if (choice !== undefined && !slot.options.includes(choice)) {
        return `That target is no longer legal for slot ${slot.slot + 1}.`;
      }
    }

    const response: DecisionResponse = {
      requestId: payload.requestId,
      actionId: payload.actionId,
      ...(suppliedTargets.length > 0 ? { targets: suppliedTargets } : {}),
    };
    this.pending = null;
    pending.resolve(response);
    return null;
  }

  /** Release an abandoned runner without applying the response (it observes abandonment first). */
  releaseForAbandon(): void {
    const pending = this.pending;
    if (pending === null) return;
    const action = pending.request.legalActions[0];
    if (action === undefined) return;
    this.pending = null;
    pending.resolve({ requestId: pending.request.requestId, actionId: action.id });
  }
}

/** Gate checked before every new bot call. Disconnects do not cancel an already in-flight call. */
export class PlayerConnectionGate {
  private connected = true;
  private waiters: Array<() => void> = [];

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) return;
    for (const wake of this.waiters.splice(0)) wake();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async wait(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.connected = true;
    for (const wake of this.waiters.splice(0)) wake();
  }
}
