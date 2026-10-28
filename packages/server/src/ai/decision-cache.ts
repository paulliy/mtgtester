/**
 * Decision cache: when the exact same decision comes back in the exact same game state,
 * reuse the answer instead of paying another Gemini call.
 *
 * A stalled board produces this constantly. In a logged 30-turn game an idle player was asked
 * the identical upkeep/draw/end-step question across ten consecutive turns with an unchanged
 * hand and an unchanged battlefield; the model returned the same answer every time. The turn
 * number differs, but nothing the answer depends on does.
 *
 * The key is therefore a content digest of everything a correct answer could depend on, and
 * deliberately *not* the turn number or request id. Same board, same hand, same mana, same
 * menu, same phase ⇒ same answer. This mirrors the engine's layer-cache reasoning (ADR 0007):
 * key on content rather than on a revision counter, so a change we forgot to account for
 * changes the key rather than silently returning something stale.
 *
 * The cached `actionId` is an index into the legal-action menu, so the menu itself is folded
 * into the key — a hit therefore guarantees the stored id still denotes the same action. The
 * cache is per game and bounded; it is a cost optimisation, and dropping an entry only costs
 * one ordinary AI call.
 */

import type { DecisionRequest, DecisionResponse, PlayerView } from '@mtg/shared';

/** FNV-1a mixing, as used by the engine's layer cache. */
function mix(h: number, x: number): number {
  return Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
}

function hashString(h: number, s: string): number {
  let acc = h;
  for (let i = 0; i < s.length; i++) acc = mix(acc, s.charCodeAt(i));
  return acc;
}

function hashNumber(h: number, n: number | null | undefined): number {
  // Offset so negatives stay distinct, and give null its own slot.
  return mix(h, n === null || n === undefined ? 0 : n + 0x10000);
}

/**
 * Digest of everything an answer could legitimately depend on. Excludes `requestId` and
 * `turn`: an idle upkeep on turn 8 and on turn 12 are the same decision if nothing else moved.
 */
export function digestDecision(
  request: DecisionRequest,
  view: PlayerView,
  /**
   * Anything else the prompt carries that should split the key: the seat's deals (ADR 0035).
   * Absent leaves the key as it always was.
   */
  context?: string,
): number {
  let h = 0x811c9dc5;
  if (context !== undefined) h = hashString(h, context);

  h = hashString(h, request.decidingPlayer);
  h = hashString(h, request.activePlayer);
  h = hashString(h, request.decisionType);
  h = hashString(h, request.phase);
  h = hashString(h, request.step ?? 'none');
  h = hashString(h, request.prompt);

  // Choice contracts carry object identities, totals and bounds outside the menu.
  const { requestId: _requestId, turn: _turn, ...contract } = request;
  h = hashString(h, JSON.stringify(contract));

  // The menu: a cached actionId is an index into it, so it must be part of the key.
  h = mix(h, request.legalActions.length);
  for (const action of request.legalActions) {
    h = mix(h, action.id);
    h = hashString(h, action.type);
    h = hashString(h, action.description);
    for (const slot of action.targets ?? []) {
      h = mix(h, slot.slot);
      h = mix(h, slot.options.length);
      for (const option of slot.options) h = hashString(h, option);
    }
  }

  // The viewer's own resources.
  h = hashNumber(h, view.life);
  h = mix(h, view.hand.length);
  for (const card of view.hand) h = hashString(h, card.name);
  h = mix(h, view.graveyard.length);
  for (const [color, amount] of Object.entries(view.availableMana).sort()) {
    h = hashString(h, color);
    h = hashNumber(h, amount);
  }
  for (const source of view.manaSources) {
    h = hashString(h, source.name);
    h = mix(h, source.count);
    for (const symbol of source.symbols) h = hashString(h, symbol);
  }
  for (const commander of view.commanders) {
    h = hashString(h, commander.name);
    h = hashString(h, commander.zone);
    h = hashNumber(h, commander.castCount);
  }

  // Every battlefield — public state that any sensible answer reads.
  h = mix(h, view.battlefield.length);
  for (const perm of view.battlefield) {
    h = hashString(h, perm.id);
    h = hashString(h, perm.controller);
    h = hashString(h, perm.name);
    h = hashNumber(h, perm.power);
    h = hashNumber(h, perm.toughness);
    h = mix(h, perm.tapped ? 1 : 2);
    for (const status of perm.status) h = hashString(h, status);
  }

  h = mix(h, view.stack.length);
  for (const item of view.stack) {
    h = hashString(h, item.id);
    h = hashString(h, item.controller);
    h = hashString(h, item.description);
    for (const target of item.targets) h = hashString(h, target);
  }

  // The viewer's own poison, now in its view and its prompt. Absent and zero hash the same, so a
  // seat without poison keeps the key it always had.
  if ((view.poisonCounters ?? 0) > 0) h = hashNumber(h, view.poisonCounters);
  for (const opp of view.opponents) {
    h = hashString(h, opp.seat);
    h = hashNumber(h, opp.life);
    h = hashNumber(h, opp.handSize);
    h = hashNumber(h, opp.librarySize);
    h = hashNumber(h, opp.poisonCounters);
    h = hashNumber(h, opp.commanderDamageDealtToYou);
  }

  return h;
}

/** What the cache stores — the answer stripped of its (per-request) identity. */
type CachedAnswer = Omit<DecisionResponse, 'requestId' | 'note'>;

const DEFAULT_MAX_ENTRIES = 200;

/** Bounded LRU of answers, scoped to a single game. */
export class DecisionCache {
  private readonly entries = new Map<number, CachedAnswer>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  get size(): number {
    return this.entries.size;
  }

  /** The previous answer to this exact decision, re-stamped with the current request id. */
  get(request: DecisionRequest, view: PlayerView, context?: string): DecisionResponse | null {
    const key = digestDecision(request, view, context);
    const hit = this.entries.get(key);
    if (hit === undefined) return null;

    // Refresh recency: re-inserting moves the key to the end of Map iteration order.
    this.entries.delete(key);
    this.entries.set(key, hit);

    const response: DecisionResponse = {
      ...structuredClone(hit),
      requestId: request.requestId,
      note: 'Cache: identical game state and menu already decided',
    };
    return response;
  }

  set(
    request: DecisionRequest,
    view: PlayerView,
    response: DecisionResponse,
    context?: string,
  ): void {
    const key = digestDecision(request, view, context);
    const { requestId: _requestId, note: _note, ...answer } = structuredClone(response);

    this.entries.delete(key);
    this.entries.set(key, answer);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
