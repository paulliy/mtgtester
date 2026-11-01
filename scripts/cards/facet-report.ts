/**
 * Facet warnings (ADR 0034 decision 6) as `card:check` and the card gate print them: a facet whose
 * count differs between the Oracle text and the definition, or the manifest's `facetNotes` reason
 * for it when the difference is a known modeling choice.
 */
import type { OracleCard } from '../../packages/shared/src';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { facetMismatches } from '../../packages/engine/src/cards/facets';

export interface FacetNote {
  facet: string;
  reason: string;
}

/** A manifest card entry's `facetNotes`, found by its name. */
export function facetNotes(manifestJson: string, card: string): FacetNote[] {
  const manifest = JSON.parse(manifestJson) as {
    cards: Record<string, { name: string; facetNotes?: FacetNote[] }>;
  };
  return Object.values(manifest.cards).find((entry) => entry.name === card)?.facetNotes ?? [];
}

/** One line per facet that differs; a noted one says why instead of warning. */
export function facetReport(
  card: OracleCard,
  definition: CardDefinition,
  notes: readonly FacetNote[],
): string[] {
  return facetMismatches(card, definition).map(({ facet, text, ir }) => {
    const note = notes.find((candidate) => candidate.facet === facet);
    const counts = `the text says ${text}, the IR has ${ir}`;
    return note === undefined
      ? `warning: ${facet}: ${counts}`
      : `noted: ${facet} (${counts}): ${note.reason}`;
  });
}
