import type { Ability, Effect, TargetSpec } from './ability';
import type { CardDefinition } from './definition';
import { allOf, ofType, OPPONENTS } from './selector';
import { enforceCardDefinition } from './authoring-validation';

type FieldRole = 'copy' | 'lower' | 'unsupported';
const abilityFields = {
  kind: 'copy',
  targets: 'lower',
  effects: 'lower',
  description: 'copy',
  cantBeCountered: 'copy',
  trigger: 'unsupported',
  optional: 'unsupported',
  modes: 'unsupported',
  functionsInGraveyard: 'unsupported',
} satisfies Record<keyof Ability, FieldRole>;
const targetFields = {
  random: 'unsupported',
  differentPlayerTargetSlots: 'unsupported',
  kind: 'lower',
  controller: 'lower',
  filter: 'unsupported',
  count: 'unsupported',
  totalManaValueAtMost: 'unsupported',
  graveyardOwnerSlot: 'unsupported',
  graveyardOwnerScope: 'unsupported',
  tapState: 'unsupported',
  perPlayer: 'unsupported',
  controllerPlayer: 'unsupported',
  slotGroup: 'unsupported',
  spellTargetsPermanentYouControl: 'unsupported',
  spellHasSingleTarget: 'unsupported',
  stackTargetsYouOrCreatureYouControl: 'unsupported',
  stackKind: 'unsupported',
  differentFromSlots: 'unsupported',
} satisfies Record<keyof TargetSpec, FieldRole>;
const returnFields = { op: 'lower', target: 'lower' } satisfies Record<
  keyof Extract<Effect, { op: 'returnToHand' }>,
  FieldRole
>;
const destroyFields = { op: 'lower', target: 'lower', cantRegenerate: 'copy' } satisfies Record<
  keyof Extract<Effect, { op: 'destroy' }>,
  FieldRole
>;
const exileSearchFields = { op: 'lower', target: 'lower' } satisfies Record<
  keyof Extract<Effect, { op: 'exileCreatureAndControllerSearchBasicLand' }>,
  FieldRole
>;
const discardFields = {
  op: 'lower',
  target: 'lower',
  count: 'copy',
  atRandom: 'unsupported',
} satisfies Record<keyof Extract<Effect, { op: 'discardTarget' }>, FieldRole>;
function withinFields(value: object, fields: Record<string, FieldRole>): boolean {
  return Object.entries(value).every(
    ([key, entry]) =>
      Object.hasOwn(fields, key) && (entry === undefined || fields[key] !== 'unsupported'),
  );
}

/** Faithful, deliberately bounded lowering; unsupported text never borrows another effect. */
export function deriveOverloadAbility(ability: Ability | null): Ability | null {
  if (
    !ability ||
    ability.kind !== 'spell' ||
    !withinFields(ability, abilityFields) ||
    ability.targets.length !== 1 ||
    ability.effects.length !== 1
  )
    return null;
  const target = ability.targets[0]!;
  const effect = ability.effects[0]!;
  if (!withinFields(target, targetFields)) return null;
  if (
    effect.op === 'exileCreatureAndControllerSearchBasicLand' &&
    withinFields(effect, exileSearchFields) &&
    effect.target === 0 &&
    target.kind === 'creature' &&
    target.controller === 'opponent'
  ) {
    return {
      ...ability,
      targets: [],
      effects: [
        {
          op: 'exileEachCreatureAndControllersSearchBasicLands',
          selector: allOf(ofType('Creature'), OPPONENTS),
        },
      ],
    };
  }
  if (
    effect.op === 'returnToHand' &&
    withinFields(effect, returnFields) &&
    effect.target === 0 &&
    target.controller === 'opponent' &&
    target.kind === 'nonlandPermanent'
  ) {
    return { ...ability, targets: [], effects: [{ op: 'overloadBounceAllNonlandOpponents' }] };
  }
  // "Target player discards two cards" overloaded is "Each player discards two cards" (Mind
  // Rake, CR 702.96b); "target opponent" becomes each opponent.
  if (
    effect.op === 'discardTarget' &&
    withinFields(effect, discardFields) &&
    effect.target === 0 &&
    target.kind === 'player' &&
    (target.controller === undefined || target.controller === 'opponent')
  ) {
    return {
      ...ability,
      targets: [],
      effects: [
        {
          op: 'discardEachPlayer',
          scope: target.controller === 'opponent' ? 'opponents' : 'all',
          count: effect.count,
        },
      ],
    };
  }
  if (
    effect.op === 'destroy' &&
    withinFields(effect, destroyFields) &&
    effect.target === 0 &&
    ((target.kind === 'artifact' && target.controller === 'opponent') ||
      (target.kind === 'creature' && target.controller === undefined))
  ) {
    return {
      ...ability,
      targets: [],
      effects: [
        {
          op: 'destroyEach',
          selector:
            target.kind === 'artifact' ? allOf(ofType('Artifact'), OPPONENTS) : ofType('Creature'),
          ...(effect.cantRegenerate === undefined ? {} : { cantRegenerate: effect.cantRegenerate }),
        },
      ],
    };
  }
  return null;
}

export function enforceInterpretedDefinition(definition: CardDefinition): CardDefinition {
  return enforceCardDefinition(completeOverloadAbilities(definition));
}

/** Lower missing parser output only after overrides have produced the final base ability. */
export function completeOverloadAbilities(definition: CardDefinition): CardDefinition {
  if (
    !definition.alternativeCasts?.some(
      (alternative) => alternative.kind === 'overload' && alternative.ability === undefined,
    )
  )
    return definition;
  const ability = deriveOverloadAbility(definition.spellAbility);
  return {
    ...definition,
    alternativeCasts: definition.alternativeCasts.map((alternative) =>
      alternative.kind === 'overload' && alternative.ability === undefined && ability
        ? { ...alternative, ability }
        : alternative,
    ),
  };
}
