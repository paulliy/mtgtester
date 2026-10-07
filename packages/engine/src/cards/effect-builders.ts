import type { AbilityCost, AlternativeCast, Effect, SearchDestination } from './ability';
import type { Selector } from './selector';
import type { ParsedManaCost } from '../mana/cost';
import { validateExpression, validateParsedManaCost } from './expression-validation';
import { validateOverrideDefinition } from './authoring-validation';

function fields(value: object, allowed: readonly string[]): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('effect builder: unknown options');
}
function slot(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('effect builder: invalid ordinary target slot');
}
function selector(value: Selector): void {
  const issues: { path: string; message: string }[] = [];
  validateExpression('selector', value, 'filter', issues);
  if (issues.length) throw new Error('effect builder: invalid selector');
}

/** Destination is explicit; the owning ability still validates the graveyard-card slot. */
export function returnGraveyardCard(
  target: number,
  destination: 'battlefield' | 'hand' | 'libraryTop',
): Effect {
  slot(target);
  if (destination === 'battlefield') return { op: 'graveyardToBattlefield', target };
  if (destination === 'hand') return { op: 'graveyardToHand', target };
  if (destination === 'libraryTop') return { op: 'graveyardToLibraryTop', target };
  throw new Error('effect builder: unsupported graveyard destination');
}

/** The source's battlefield lifetime owns the exile link; this does not create cast permission. */
export function exileUntilThisSourceLeaves(targetSlot: number): Effect {
  slot(targetSlot);
  return { op: 'exileUntilSourceLeaves', targetSlot };
}

/** An existing Hideaway link includes its explicit spell/land play opportunity. */
export function playLinkedExiledCardWithoutManaCost(): Effect {
  return { op: 'playExiledCardFree' };
}

/** Only the existing hand and library-search cast envelopes are represented by this builder. */
export function castWithoutManaCost(
  configuration:
    { from: 'hand'; maxManaValue?: number } | { from: 'librarySearch'; filter: Selector },
): Effect {
  if (configuration?.from === 'hand') {
    fields(configuration, ['from', 'maxManaValue']);
    if (configuration.maxManaValue === undefined) return { op: 'castAnyFromHandFree' };
    if (!Number.isSafeInteger(configuration.maxManaValue) || configuration.maxManaValue < 0)
      throw new Error('effect builder: invalid free-cast mana value bound');
    return { op: 'castOneFromHandFreeUpTo', maxManaValue: configuration.maxManaValue };
  }
  if (configuration?.from === 'librarySearch') {
    fields(configuration, ['from', 'filter']);
    selector(configuration.filter);
    return { op: 'searchLibraryCastFree', filter: configuration.filter };
  }
  throw new Error('effect builder: unsupported free-cast origin');
}

interface LibrarySearchOptions {
  count?: number;
  differentNames?: boolean;
  bind?: string;
  allowFailToFind?: boolean;
  reveal?: boolean;
}
/** Searching chooses cards; no TargetSpec, hexproof, shroud or protection is introduced. */
export function searchLibraryCards(
  filter: Selector,
  destinations: readonly SearchDestination[],
  configuration: LibrarySearchOptions = {},
): Effect {
  selector(filter);
  fields(configuration, ['count', 'differentNames', 'bind', 'allowFailToFind', 'reveal']);
  if (!Array.isArray(destinations) || destinations.length === 0)
    throw new Error('effect builder: search requires destinations');
  for (const destination of destinations) {
    fields(destination, ['zone', 'tapped']);
    if (
      !['battlefield', 'hand', 'graveyard', 'libraryTop'].includes(destination.zone) ||
      (destination.tapped !== undefined &&
        (typeof destination.tapped !== 'boolean' || destination.zone !== 'battlefield'))
    )
      throw new Error('effect builder: invalid search destination');
  }
  if (
    configuration.count !== undefined &&
    (!Number.isSafeInteger(configuration.count) || configuration.count < 0)
  )
    throw new Error('effect builder: invalid fixed search count');
  for (const key of ['differentNames', 'allowFailToFind', 'reveal'] as const)
    if (configuration[key] !== undefined && typeof configuration[key] !== 'boolean')
      throw new Error('effect builder: invalid search flag');
  if (
    configuration.bind !== undefined &&
    (typeof configuration.bind !== 'string' || configuration.bind.length === 0)
  )
    throw new Error('effect builder: invalid search binding');
  return {
    op: 'searchLibrary',
    filter,
    destinations: destinations.map((destination) => ({ ...destination })),
    ...(configuration.count === undefined
      ? {}
      : { count: { kind: 'const', n: configuration.count } }),
    ...(configuration.differentNames === undefined
      ? {}
      : { differentNames: configuration.differentNames }),
    ...(configuration.bind === undefined ? {} : { bind: configuration.bind }),
    ...(configuration.allowFailToFind === undefined
      ? {}
      : { allowFailToFind: configuration.allowFailToFind }),
    ...(configuration.reveal === undefined ? {} : { reveal: configuration.reveal }),
  };
}

/** Flashback and Escape have different stack destinations and must not borrow each other's flag. */
export function graveyardAlternativeCost(
  mechanic: 'flashback' | 'escape',
  manaCost: ParsedManaCost,
  configuration: { description: string; costs?: AbilityCost[] },
): AlternativeCast {
  fields(configuration, ['description', 'costs']);
  if (!['flashback', 'escape'].includes(mechanic))
    throw new Error('effect builder: unsupported graveyard casting mechanic');
  const issues: { path: string; message: string }[] = [];
  validateParsedManaCost(manaCost, 'manaCost', issues);
  if (
    issues.length ||
    typeof configuration.description !== 'string' ||
    configuration.description.length === 0
  )
    throw new Error('effect builder: invalid graveyard alternative cost');
  if (configuration.costs !== undefined && !Array.isArray(configuration.costs))
    throw new Error('effect builder: invalid alternative cost components');
  const alternative: AlternativeCast = {
    kind: 'nonMana',
    from: 'graveyard',
    manaCost,
    ...(configuration.costs === undefined || configuration.costs.length === 0
      ? {}
      : { costs: configuration.costs.map((cost) => ({ ...cost })) }),
    ...(mechanic === 'flashback' ? { exileOnResolution: true } : { escaped: true }),
    description: configuration.description,
  };
  // A partial authored envelope validates cost kinds and unknown fields without inventing an ability.
  if (
    validateOverrideDefinition({
      oracleId: 'builder-cost-probe',
      name: 'Builder cost probe',
      handledLines: [],
      def: { alternativeCasts: [alternative] },
    }).length
  )
    throw new Error('effect builder: invalid alternative cost components');
  return alternative;
}
