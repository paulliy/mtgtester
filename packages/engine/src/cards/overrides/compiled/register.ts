/**
 * Registers every promoted compiled card as an `'append'` override, so the abilities the
 * interpreter parsed from the card's other lines are kept and the patch adds only the abilities
 * for the lines it claims. The usual drift guard applies: if a claimed line changes or the
 * interpreter starts parsing it, the card goes back to `modeled: false`.
 */
import { extendCard } from '../index';
import { COMPILED_BATCHES } from './index';
import type { CompiledCard } from './types';

/** Every promoted compiled card, by Oracle id. */
export function compiledCards(): Map<string, CompiledCard & { batch: string }> {
  const byId = new Map<string, CompiledCard & { batch: string }>();
  for (const batch of COMPILED_BATCHES)
    for (const card of batch.cards) {
      const earlier = byId.get(card.oracleId);
      if (earlier !== undefined)
        throw new Error(
          `compiled card "${card.name}" is in two batches: ${earlier.batch} and ${batch.id}`,
        );
      byId.set(card.oracleId, { ...card, batch: batch.id });
    }
  return byId;
}

export function registerCompiledOverrides(): void {
  for (const card of compiledCards().values())
    extendCard(card.oracleId, card.name, card.handledLines, card.def);
}
