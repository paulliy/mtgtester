import type { AlternativeCast } from './ability';
import type { CardDefinition } from './definition';

/** CR 715/716: selecting a spell face changes its characteristics, not the physical card. */
export function selectedSpellDefinition(
  definition: CardDefinition,
  alternative?: AlternativeCast,
): CardDefinition {
  if (alternative?.kind === 'bestow') return bestowedDefinition(definition);
  if (alternative?.kind !== 'adventure' && alternative?.kind !== 'omen') return definition;
  return spellFaceOf(alternative);
}

export function spellFaceOf(alternative: AlternativeCast): CardDefinition {
  const face = alternative.spellFace;
  if (
    face === undefined ||
    !face.modeled ||
    face.hasUnsupportedCost ||
    face.manaCost === null ||
    face.spellAbility?.kind !== 'spell' ||
    face.types.length !== 1 ||
    !['Instant', 'Sorcery'].includes(face.types[0]!) ||
    !face.subtypes.includes(alternative.kind === 'omen' ? 'Omen' : 'Adventure') ||
    JSON.stringify(face.manaCost) !== JSON.stringify(alternative.manaCost) ||
    (alternative.name !== undefined && alternative.name !== face.name) ||
    (alternative.typeLine !== undefined && alternative.typeLine !== face.typeLine) ||
    (alternative.ability !== undefined &&
      JSON.stringify(alternative.ability) !== JSON.stringify(face.spellAbility)) ||
    (alternative.costs?.length ?? 0) > 0 ||
    alternative.landFace !== undefined ||
    alternative.exileOnResolution === true ||
    alternative.escaped === true
  )
    throw new Error('alternative spell face has no valid executable characteristics');
  return face;
}

/** Enchant creature, as a bestowed Aura has it (CR 702.103b). */
export const BESTOW_ENCHANT: import('./ability').TargetSpec = { kind: 'creature' };

/**
 * A spell cast bestowed (CR 702.103b): it becomes an Aura enchantment — no longer a creature,
 * its creature types gone with the type it belonged to (CR 205.1a) — and gains enchant creature,
 * so its only target is the creature it will enchant. Only these characteristics decide whether
 * it can be cast (CR 702.103d).
 */
export function bestowedDefinition(definition: CardDefinition): CardDefinition {
  return {
    ...definition,
    types: ['Enchantment'],
    subtypes: ['Aura'],
    spellAbility: { kind: 'spell', targets: [BESTOW_ENCHANT], effects: [] },
  };
}
