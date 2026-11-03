/**
 * Slot diagnostics for the card grammar (ADR 0038 decision 2).
 *
 * When a slot parser cannot read its text it returns null, and the card's `unmodeledReasons`
 * only says which rules line was not understood. Diagnostics say which slot inside that line
 * failed: `amount "the number of Shrines you control"`, `trigger event "whenever you cycle this
 * card, …"`. They feed triage (`edhrec:triage`), not the engine: `interpretCard` never reads
 * them, its output does not change, and nothing is recorded unless a caller asks.
 *
 * Collection is synchronous and scoped to one `collectSlotDiagnostics` call, so concurrent
 * games are unaffected: the collector is null outside that call and `noteSlotFailure` returns at
 * once.
 */

export type GrammarSlot =
  | 'subject'
  | 'card filter'
  | 'spell filter'
  | 'target'
  | 'amount'
  | 'condition'
  | 'cost'
  | 'trigger event'
  | 'effect';

export interface SlotFailure {
  slot: GrammarSlot;
  /** The text the slot parser was given, as it received it (usually lowercased). */
  text: string;
}

let collector: SlotFailure[] | null = null;

/** Record that `slot` could not parse `text`. A no-op outside `collectSlotDiagnostics`. */
export function noteSlotFailure(slot: GrammarSlot, text: unknown): void {
  if (collector === null || typeof text !== 'string') return;
  collector.push({ slot, text });
}

/**
 * Run `fn` and return its result with every slot failure recorded while it ran, in the order
 * they happened. A parser that tries several readings records the ones that failed, so a
 * failure is a lead, not a verdict: the reading that finally matched may have failed elsewhere
 * first.
 */
export function collectSlotDiagnostics<T>(fn: () => T): { result: T; failures: SlotFailure[] } {
  const previous = collector;
  const failures: SlotFailure[] = [];
  collector = failures;
  try {
    return { result: fn(), failures };
  } finally {
    collector = previous;
  }
}
