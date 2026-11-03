import { colorsOfManaCost, combinedManaCost } from '../mana/cost';
import type { AlternativeCast } from './ability';
import type { CardDefinition } from './definition';

/** A Room's halves (CR 709.5j), in printed order. */
export type RoomDoor = 'left' | 'right';

/** CR 715/716: selecting a spell face changes its characteristics, not the physical card. */
export function selectedSpellDefinition(
  definition: CardDefinition,
  alternative?: AlternativeCast,
): CardDefinition {
  if (alternative?.kind === 'bestow') return bestowedDefinition(definition);
  if (
    alternative?.kind !== 'adventure' &&
    alternative?.kind !== 'omen' &&
    alternative?.kind !== 'mdfc' &&
    alternative?.kind !== 'split'
  )
    return definition;
  if (alternative.kind === 'mdfc' && alternative.spellFace === undefined) return definition;
  return spellFaceOf(alternative);
}

/**
 * A modal double-faced card as its land face, for judging a permission to play it ("you may play
 * lands from the top of your library"): only that face's characteristics apply (CR 712.12).
 */
export function mdfcLandFaceDefinition(
  definition: CardDefinition,
  alternative: AlternativeCast,
): CardDefinition | undefined {
  const face = alternative.kind === 'mdfc' ? alternative.landFace : undefined;
  if (face === undefined) return undefined;
  return {
    ...definition,
    // The same card: only its characteristics are the face's.
    oracleId: definition.oracleId,
    name: face.name,
    typeLine: face.typeLine,
    manaCost: null,
    colors: [...face.colors],
    supertypes: [...face.supertypes],
    types: [...face.types],
    subtypes: [...face.subtypes],
  };
}

const landFaceDefinitions = new WeakMap<CardDefinition, CardDefinition>();

/**
 * A modal double-faced permanent with its land face up (CR 712.8f): it has only that face's
 * characteristics, so none of the front face's abilities (an enters trigger, a static ability, a
 * rule static, entry counters, an as-enters copy) reach it, whatever the front face's type.
 * Memoized per definition, so the layer cache sees one definition object for the face.
 */
export function landFacePermanentDefinition(
  definition: CardDefinition,
  alternative: AlternativeCast,
): CardDefinition {
  const face = alternative.kind === 'mdfc' ? alternative.landFace : undefined;
  if (face === undefined) return definition;
  const cached = landFaceDefinitions.get(definition);
  if (cached !== undefined) return cached;
  const land: CardDefinition = {
    oracleId: definition.oracleId,
    ...(definition.scryfallId !== undefined ? { scryfallId: definition.scryfallId } : {}),
    name: face.name,
    typeLine: face.typeLine,
    supertypes: [...face.supertypes],
    types: [...face.types],
    subtypes: [...face.subtypes],
    colors: [...face.colors],
    colorIdentity: definition.colorIdentity,
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: face.manaAbilities,
    activatedAbilities: [],
    spellAbility: null,
    entersTapped: face.entersTapped,
    ...(face.entersTappedUnless !== undefined
      ? { entersTappedUnless: face.entersTappedUnless }
      : {}),
    ...(definition.alternativeCasts !== undefined
      ? { alternativeCasts: definition.alternativeCasts }
      : {}),
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    modeled: definition.modeled,
    unmodeledReasons: definition.unmodeledReasons,
  };
  landFaceDefinitions.set(definition, land);
  return land;
}

/** Modal faces retain the chosen characteristics on the battlefield and reset elsewhere. */
export function selectedPermanentDefinition(
  definition: CardDefinition,
  face?: 'front' | 'back',
  unlockedDoors?: readonly RoomDoor[],
): CardDefinition {
  if (definition.roomDoors !== undefined) return roomDefinition(definition, unlockedDoors ?? []);
  if (face !== 'back') return definition;
  const landFace = definition.alternativeCasts?.find(
    (entry) => entry.kind === 'mdfc' && entry.landFace !== undefined,
  );
  if (landFace !== undefined) return landFacePermanentDefinition(definition, landFace);
  const alternative = definition.alternativeCasts?.find(
    (entry) => entry.kind === 'mdfc' && entry.spellFace !== undefined,
  );
  return alternative === undefined ? definition : spellFaceOf(alternative);
}

const roomDefinitions = new WeakMap<CardDefinition, Map<string, CardDefinition>>();

/**
 * A Room permanent (CR 709.5): it keeps the shared type line, but has the name, mana cost and
 * rules text of its unlocked doors only, so its colors and mana value come from those doors'
 * costs alone. With neither door unlocked it has no name, no mana cost and no abilities.
 * Memoized per door set, so the layer cache sees one definition object per state.
 */
export function roomDefinition(
  definition: CardDefinition,
  unlockedDoors: readonly RoomDoor[],
): CardDefinition {
  const doors = definition.roomDoors;
  if (doors === undefined) return definition;
  const open = (['left', 'right'] as const).filter((door) => unlockedDoors.includes(door));
  const key = open.join(',');
  let cache = roomDefinitions.get(definition);
  if (cache === undefined) roomDefinitions.set(definition, (cache = new Map()));
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const faces = open.map((door) => doors[door === 'left' ? 0 : 1]);
  const manaCost = faces.reduce<CardDefinition['manaCost']>(
    (total, face) =>
      face.manaCost === null
        ? total
        : total === null
          ? face.manaCost
          : combinedManaCost(total, face.manaCost),
    null,
  );
  const room: CardDefinition = {
    ...definition,
    name: faces.map((face) => face.name).join(' // '),
    manaCost,
    colors: colorsOfManaCost(manaCost),
    keywords: faces.flatMap((face) => face.keywords),
    manaAbilities: faces.flatMap((face) => face.manaAbilities),
    activatedAbilities: faces.flatMap((face) => face.activatedAbilities),
    triggers: faces.flatMap((face) => face.triggers),
    staticEffects: faces.flatMap((face) => face.staticEffects),
    ruleStatics: faces.flatMap((face) => face.ruleStatics),
  };
  cache.set(key, room);
  return room;
}

/** The door a Room spell cast as one half unlocks as it enters (CR 709.5d). */
export function roomDoorOf(
  definition: CardDefinition,
  alternative: AlternativeCast | undefined,
): RoomDoor | undefined {
  const doors = definition.roomDoors;
  if (doors === undefined || alternative?.kind !== 'split') return undefined;
  return alternative.spellFace === doors[0]
    ? 'left'
    : alternative.spellFace === doors[1]
      ? 'right'
      : alternative.name === doors[0].name
        ? 'left'
        : alternative.name === doors[1].name
          ? 'right'
          : undefined;
}

export function spellFaceOf(alternative: AlternativeCast): CardDefinition {
  const face = alternative.spellFace;
  if (
    face === undefined ||
    !face.modeled ||
    face.hasUnsupportedCost ||
    face.manaCost === null ||
    face.spellAbility?.kind !== 'spell' ||
    (alternative.kind === 'mdfc' &&
      (alternative.spellFaceText === undefined ||
        typeof alternative.spellFaceText.oracleText !== 'string' ||
        typeof alternative.spellFaceText.frontOracleText !== 'string' ||
        typeof alternative.spellFaceText.manaCost !== 'string')) ||
    (alternative.kind === 'mdfc'
      ? !face.types.some((type) =>
          [
            'Artifact',
            'Battle',
            'Creature',
            'Enchantment',
            'Planeswalker',
            'Instant',
            'Sorcery',
          ].includes(type),
        ) || face.types.includes('Land')
      : alternative.kind === 'split'
        ? face.types.length === 0 ||
          (face.subtypes.includes('Room')
            ? alternative.fused === true ||
              face.types.some((type) => type === 'Instant' || type === 'Sorcery' || type === 'Land')
            : !face.types.every((type) => type === 'Instant' || type === 'Sorcery')) ||
          (alternative.fused === true && alternative.from !== 'hand')
        : face.types.length !== 1 ||
          !['Instant', 'Sorcery'].includes(face.types[0]!) ||
          !face.subtypes.includes(alternative.kind === 'omen' ? 'Omen' : 'Adventure')) ||
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
