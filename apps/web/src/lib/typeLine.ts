/**
 * A printed type line split for the Decktank card tile (redesign plan, phase 5.1): supertypes go
 * in a tag on the art, card types on a muted line, subtypes in Bodoni after them. Display only:
 * the engine's computed types decide every rule, and this only reads the line the server already
 * sends for the card (`typeLine`). A face pair ("Instant // Land") shows its first face.
 */

export interface TypeLineParts {
  /** The supertype the tile tags, if any: Legendary, Basic, Snow or World. */
  supertypes: string[];
  /** Card types, as printed: "Artifact Creature". */
  types: string;
  /** Subtypes, as printed: "Human Wizard". Empty when the card has none. */
  subtypes: string;
}

const SUPERTYPES = new Set(['Legendary', 'Basic', 'Snow', 'World', 'Ongoing', 'Elite', 'Host']);

export function splitTypeLine(typeLine: string | null | undefined): TypeLineParts {
  const face = (typeLine ?? '').split('//')[0]!.trim();
  const [left = '', right = ''] = face.split(/\s+[—–-]\s+/, 2);
  const words = left.split(/\s+/).filter((word) => word !== '');
  const supertypes = words.filter((word) => SUPERTYPES.has(word));
  const types = words.filter((word) => !SUPERTYPES.has(word)).join(' ');
  return { supertypes, types, subtypes: right.trim() };
}
