import type { AlternativeCast } from './ability';
import type { CardDefinition } from './definition';

/** CR 715/716: selecting a spell face changes its characteristics, not the physical card. */
export function selectedSpellDefinition(
  definition: CardDefinition,
  alternative?: AlternativeCast,
): CardDefinition {
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
