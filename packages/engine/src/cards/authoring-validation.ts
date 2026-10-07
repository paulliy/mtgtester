import { supportsAdditionalXAnnouncement } from './cost-contracts';
import { spellFaceOf } from './spell-faces';
import type { AlternativeCast, DynamicManaKind } from './ability';
import { selectorIsEventOnly } from './selector';
import { validateIRGraph } from './ir-graph';
import { validateManaRiders } from './mana-riders';
import { validateCardIRFields } from './capabilities';
import {
  validateExpression,
  validateEffectExpressions,
  validateParsedManaCost,
} from './expression-validation';
import { isChoiceCondition } from './condition';
import type { AbilityCost, Effect, TargetSpec } from './ability';
import type { CardDefinition } from './definition';
import type { CardOverride } from './overrides';
import {
  EFFECT_REFERENCE_CONTRACTS,
  playerFilterAlwaysTrue,
  targetDomains,
} from './effect-reference-contracts';
import type { ReferenceContract, TargetDomain } from './effect-reference-contracts';
import { assertNever } from '../utils/assert-never';

export interface AuthoringIssue {
  path: string;
  message: string;
}
interface Scope {
  targets: TargetSpec[];
  activeSlots?: readonly number[];
  narrowedDomains?: ReadonlyMap<number, readonly TargetDomain[]>;
}
const integer = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const specialRefs = new Set(['source', 'triggerObject', 'attachedToSource', 'eventPlayer']);
const dynamicManaKinds = {
  commanderIdentity: true,
  opponentLandColors: true,
  chosenColor: true,
  colorsAmongPermanents: true,
  oneColorAmongPermanents: true,
  ownLandTypes: true,
  legendaryPermanentColors: true,
} satisfies Record<DynamicManaKind, true>;

function checkReference(
  value: unknown,
  path: string,
  contract: ReferenceContract,
  scope: Scope | undefined,
  issues: AuthoringIssue[],
): void {
  if (value === undefined && contract.optional === true) return;
  if (typeof value === 'string') {
    if (contract.nonTargetRefs?.some((ref) => ref === value)) return;
    if (contract.selection !== 'ordinary' || !specialRefs.has(value)) {
      issues.push({ path, message: 'unknown non-target reference' });
    } else if (value === 'eventPlayer' && !contract.domains.includes('player')) {
      issues.push({ path, message: 'eventPlayer is incompatible with this effect domain' });
    } else if (value !== 'eventPlayer' && !contract.domains.includes('permanent')) {
      issues.push({
        path,
        message: 'permanent non-target reference is incompatible with this effect domain',
      });
    }
    return;
  }
  if (!integer(value) || scope === undefined || scope.targets[value] === undefined) {
    issues.push({
      path,
      message: `target slot ${String(value)} is outside the ability target list`,
    });
    return;
  }
  const spec = scope.targets[value]!;
  if (spec === null || typeof spec !== 'object') {
    issues.push({ path, message: 'invalid target specification' });
    return;
  }
  if (
    (spec.count !== undefined) !== (contract.selection === 'counted') ||
    (contract.selection === 'ordinary' &&
      value >= scope.targets.filter((target) => target.count === undefined).length)
  ) {
    issues.push({
      path,
      message:
        contract.selection === 'ordinary'
          ? `effect target ${value} does not reference an ordinary target slot`
          : `effect target ${value} does not reference a variable-count target slot`,
    });
  }
  if (scope.activeSlots !== undefined && !scope.activeSlots.includes(value)) {
    issues.push({ path, message: `target slot ${value} is not owned by this mode` });
  }
  try {
    const domains = scope.narrowedDomains?.get(value) ?? targetDomains(spec.kind);
    if (domains.some((domain) => !contract.domains.includes(domain)))
      issues.push({
        path,
        message: `${spec.kind} is incompatible with effect domains ${contract.domains.join(', ')}`,
      });
  } catch {
    issues.push({ path, message: 'unknown target domain' });
  }
}

function validateTargets(targets: TargetSpec[], path: string, issues: AuthoringIssue[]): void {
  let seenCounted = false;
  for (const [slot, spec] of targets.entries()) {
    const at = `${path}[${slot}]`;
    if (spec === null || typeof spec !== 'object') {
      issues.push({ path: at, message: 'invalid target specification' });
      continue;
    }
    if (
      spec.controller !== undefined &&
      !['you', 'opponent', 'eventPlayer'].includes(spec.controller)
    )
      issues.push({ path: `${at}.controller`, message: 'unknown target controller scope' });
    if (
      spec.graveyardOwnerScope !== undefined &&
      !['controller', 'opponent', 'any'].includes(spec.graveyardOwnerScope)
    )
      issues.push({ path: `${at}.graveyardOwnerScope`, message: 'unknown graveyard owner scope' });
    if (
      spec.controller !== undefined &&
      ['cardInGraveyard', 'commanderInCommandZone'].includes(spec.kind)
    )
      issues.push({
        path: `${at}.controller`,
        message: 'card targets require an implemented owner scope rather than permanent control',
      });
    const filterIssueCount = issues.length;
    if (spec.filter !== undefined)
      validateExpression('selector', spec.filter, `${at}.filter`, issues);
    const validFilter = issues.length === filterIssueCount;
    let knownDomain = true;
    try {
      targetDomains(spec.kind);
    } catch {
      knownDomain = false;
      issues.push({ path: at, message: 'unknown target domain' });
    }
    if (spec.count !== undefined && (spec.count === null || typeof spec.count !== 'object')) {
      issues.push({ path: `${at}.count`, message: 'invalid target count' });
    } else if (spec.count !== undefined) {
      seenCounted = true;
      if (
        !integer(spec.count.min) ||
        (!integer(spec.count.max) && spec.count.max !== Infinity) ||
        spec.count.min > spec.count.max
      )
        issues.push({
          path: `${at}.count`,
          message: 'target count must have integer bounds with 0 <= min <= max',
        });
    } else if (seenCounted) {
      issues.push({
        path,
        message: 'variable-count target slots must follow every ordinary target slot',
      });
    }
    if (
      spec.totalManaValueAtMost !== undefined &&
      (!integer(spec.totalManaValueAtMost) ||
        spec.count === undefined ||
        !knownDomain ||
        !targetDomains(spec.kind).includes('permanent'))
    )
      issues.push({
        path: at,
        message: 'collective mana value requires a counted battlefield target',
      });
    if (spec.graveyardOwnerSlot !== undefined) {
      const dependency = targets[spec.graveyardOwnerSlot];
      if (
        spec.kind !== 'cardInGraveyard' ||
        !integer(spec.graveyardOwnerSlot) ||
        spec.graveyardOwnerSlot >= slot ||
        dependency?.kind !== 'player' ||
        dependency.count !== undefined
      )
        issues.push({
          path: `${at}.graveyardOwnerSlot`,
          message: 'graveyard owner must reference an earlier ordinary player slot',
        });
      if (spec.graveyardOwnerScope !== undefined)
        issues.push({
          path: at,
          message: 'graveyard owner slot and owner scope are mutually exclusive',
        });
    } else if (spec.graveyardOwnerScope !== undefined && spec.kind !== 'cardInGraveyard') {
      issues.push({ path: at, message: 'graveyard owner scope requires a graveyard-card target' });
    }
    if (
      spec.filter !== undefined &&
      validFilter &&
      (['stackObject', 'commanderInCommandZone'].includes(spec.kind) ||
        (['player', 'playerOrPlaneswalker', 'anyTarget'].includes(spec.kind) &&
          !playerFilterAlwaysTrue(spec.filter)))
    )
      issues.push({
        path: at,
        message: 'target filter is not implemented for every member of this domain',
      });
  }
}

function validateCost(cost: AbilityCost, path: string, issues: AuthoringIssue[]): void {
  let amount: unknown;
  switch (cost.kind) {
    case 'payLife':
    case 'payEnergy':
      amount = cost.amount;
      break;
    case 'discardCard':
    case 'sacrificeOther':
    case 'exileCardFromHand':
      amount = cost.count ?? 1;
      break;
    case 'tapOthers':
    case 'exileOtherCardsFromGraveyard':
      amount = cost.count;
      break;
    case 'tapCreaturesTotalPower':
      amount = cost.minPower;
      break;
    case 'loyalty':
      if (!Number.isInteger(cost.delta))
        issues.push({ path, message: 'loyalty delta must be an integer' });
      break;
    case 'removeCounters':
      if (typeof cost.count === 'number') amount = cost.count;
      break;
    case 'tap':
    case 'tapOther':
    case 'tapXOthers':
    case 'sacrificeSelf':
    case 'exileSelf':
    case 'discardSelf':
    case 'discardHand':
    case 'payLifeValue':
    case 'exileSelfFromGraveyard':
    case 'unattachSelf':
      break;
    case 'mana':
      validateManaCost(cost.cost, `${path}.cost`, issues);
      break;
    default:
      assertNever(cost, 'authoring cost');
  }
  if (
    (amount !== undefined ||
      [
        'payLife',
        'payEnergy',
        'tapOthers',
        'exileOtherCardsFromGraveyard',
        'tapCreaturesTotalPower',
      ].includes(cost.kind)) &&
    !integer(amount)
  )
    issues.push({ path, message: 'cost amount must be a nonnegative integer' });
}

const validateManaCost = validateParsedManaCost;

function validateFields(
  definition: Partial<CardDefinition>,
  path: string,
  issues: AuthoringIssue[],
): void {
  try {
    validateCardIRFields(definition);
  } catch (error) {
    issues.push({
      path,
      message: error instanceof Error ? error.message : 'unclassified executable IR',
    });
  }
}

function visit(value: unknown, path: string, issues: AuthoringIssue[], scope?: Scope): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, issues, scope));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record['dynamic'] !== undefined &&
    (typeof record['dynamic'] !== 'string' || !Object.hasOwn(dynamicManaKinds, record['dynamic']))
  )
    issues.push({ path: `${path}.dynamic`, message: 'unknown dynamic mana kind' });
  if (record['kind'] === 'adventure' || record['kind'] === 'omen') {
    try {
      spellFaceOf(record as unknown as AlternativeCast);
    } catch (error) {
      issues.push({
        path: `${path}.spellFace`,
        message: error instanceof Error ? error.message : 'invalid spell face',
      });
    }
  }
  if (record['kind'] === 'overload') {
    const ability = record['ability'] as { kind?: unknown; targets?: unknown } | undefined;
    if (
      ability?.kind !== 'spell' ||
      !Array.isArray(ability.targets) ||
      ability.targets.length !== 0
    ) {
      issues.push({
        path: `${path}.ability`,
        message: 'overload requires an explicit executable spell ability with no targets',
      });
    }
  }
  let owningScope = scope;
  if (
    ['spell', 'triggered', 'activated'].includes(String(record['kind'])) &&
    (record['targets'] !== undefined ||
      record['effects'] !== undefined ||
      record['trigger'] !== undefined)
  ) {
    if (!Array.isArray(record['targets']) || !Array.isArray(record['effects'])) {
      issues.push({ path, message: 'ability requires target and effect arrays' });
      return;
    }
    const targets = record['targets'] as TargetSpec[];
    validateTargets(targets, `${path}.targets`, issues);
    owningScope = { targets };
  }
  if (typeof record['op'] === 'string') {
    const op = record['op'] as Effect['op'];
    validateEffectExpressions(record as unknown as Effect, path, issues);
    if (op === 'noOp')
      issues.push({
        path,
        message: 'executable noOp effects are prohibited; keep the card unsupported instead',
      });
    if (!Object.hasOwn(EFFECT_REFERENCE_CONTRACTS, op)) {
      issues.push({ path, message: `unknown effect contract ${String(op)}` });
    } else {
      const contract = EFFECT_REFERENCE_CONTRACTS[op] as Record<string, ReferenceContract>;
      for (const [field, reference] of Object.entries(contract)) {
        const ref = record[field];
        if (op === 'giveTargetPoisonCounters' && ref === 'eachOpponent') continue;
        checkReference(ref, `${path}.${field}`, reference, owningScope, issues);
      }
    }
  }
  // Typed value variants that consume ordinary target references, including nested arithmetic.
  const valueKind = record['kind'];
  if (
    [
      'countPermanentsControlledByTarget',
      'cardsInTargetHand',
      'tappedCreaturesControlledByTarget',
    ].includes(String(valueKind))
  )
    checkReference(
      record['target'],
      `${path}.target`,
      { domains: ['player'], selection: 'ordinary' },
      owningScope,
      issues,
    );
  if (['powerOfTarget', 'countersOnTarget', 'manaValueOfTarget'].includes(String(valueKind)))
    checkReference(
      record['target'],
      `${path}.target`,
      { domains: ['permanent'], selection: 'ordinary' },
      owningScope,
      issues,
    );

  if (record['layer'] === 7) {
    for (const field of ['power', 'toughness']) {
      const operand = record[field];
      if (typeof operand !== 'number')
        validateExpression('value', operand, `${path}.${field}`, issues);
      else if (!Number.isFinite(operand))
        issues.push({
          path: `${path}.${field}`,
          message: 'continuous characteristic operand must be finite',
        });
    }
  }
  if (typeof record['units'] !== 'undefined' && record['amount'] !== undefined)
    validateExpression('value', record['amount'], `${path}.amount`, issues);
  if (
    record['op'] !== undefined &&
    typeof record['op'] === 'object' &&
    record['affects'] !== undefined
  ) {
    const before = issues.length;
    validateExpression('selector', record['affects'], `${path}.affects`, issues);
    if (
      before === issues.length &&
      selectorIsEventOnly(record['affects'] as import('./selector').Selector)
    )
      issues.push({
        path: `${path}.affects`,
        message: 'event-only selector cannot participate in continuous layers',
      });
  }
  for (const [key, entry] of Object.entries(record)) {
    if (['activatedAbilities', 'manaAbilities'].includes(key) && Array.isArray(entry)) {
      for (const [index, ability] of entry.entries()) {
        if (
          ability === null ||
          typeof ability !== 'object' ||
          (key === 'activatedAbilities'
            ? !Array.isArray(ability.costs)
            : ability.costs !== undefined && !Array.isArray(ability.costs))
        )
          issues.push({
            path: `${path}.${key}[${index}].costs`,
            message: 'ability costs must be an array',
          });
        if (
          key === 'manaAbilities' &&
          (ability === null || typeof ability !== 'object' || !Array.isArray(ability.units))
        )
          issues.push({
            path: `${path}.${key}[${index}].units`,
            message: 'mana units must be an array',
          });
        if (key === 'activatedAbilities' && ability?.ability?.kind !== 'activated')
          issues.push({
            path: `${path}.${key}[${index}].ability`,
            message: 'activated entry requires an activated ability',
          });
        if (key === 'manaAbilities' && ability !== null && typeof ability === 'object')
          validateManaRiders(ability.onActivate, `${path}.${key}[${index}].onActivate`, issues);
      }
    }
    if (key === 'triggers' && Array.isArray(entry))
      entry.forEach((ability, index) => {
        if (ability?.kind !== 'triggered')
          issues.push({
            path: `${path}.${key}[${index}]`,
            message: 'trigger entry requires a triggered ability',
          });
      });
    if (
      key === 'spellAbility' &&
      entry !== null &&
      (entry as { kind?: unknown } | undefined)?.kind !== 'spell'
    )
      issues.push({
        path: `${path}.spellAbility`,
        message: 'spell entry requires a spell ability',
      });

    if (
      [
        'costs',
        'spellAdditionalCosts',
        'additionalCost',
        'additionalCostPerChoiceBeyondFirst',
        'effects',
        'targets',
        'onActivate',
      ].includes(key) &&
      entry !== undefined &&
      !Array.isArray(entry)
    ) {
      issues.push({ path: `${path}.${key}`, message: `${key} must be an array` });
      continue;
    }
    if (
      key === 'units' &&
      (!Array.isArray(entry) ||
        entry.some(
          (unit) =>
            !Array.isArray(unit) ||
            unit.length === 0 ||
            unit.some((symbol) => !['W', 'U', 'B', 'R', 'G', 'C'].includes(symbol)),
        ))
    )
      issues.push({
        path: `${path}.${key}`,
        message: 'mana units require nonempty supported symbol choices',
      });
    if (key === 'modes' && (entry === null || typeof entry !== 'object')) {
      issues.push({ path: `${path}.modes`, message: 'invalid modal schema' });
      continue;
    }

    if (
      ['selector', 'filter', 'targetFilter', 'affects'].includes(key) &&
      entry !== undefined &&
      typeof entry !== 'string'
    )
      validateExpression('selector', entry, `${path}.${key}`, issues);
    if (['condition', 'entersTappedUnless'].includes(key) && entry !== undefined) {
      const before = issues.length;
      validateExpression('condition', entry, `${path}.${key}`, issues);
      if (
        issues.length === before &&
        key === 'condition' &&
        record['op'] !== 'conditionalEffect' &&
        isChoiceCondition(entry as import('./condition').Condition)
      )
        issues.push({
          path: `${path}.${key}`,
          message: 'choice condition is prohibited in a pure state predicate',
        });
    }
    if (record['kind'] === 'payLifeValue' && key === 'amount')
      validateExpression('value', entry, `${path}.${key}`, issues);
    if (
      ['removeCounters', 'entersWithCounters'].includes(String(record['kind'])) &&
      key === 'count' &&
      typeof entry !== 'number'
    )
      validateExpression('value', entry, `${path}.${key}`, issues);
    if (
      key === 'entersWithCounters' &&
      entry !== undefined &&
      entry !== null &&
      typeof entry === 'object'
    )
      for (const [counter, count] of Object.entries(entry))
        if (typeof count !== 'number')
          validateExpression('value', count, `${path}.${key}.${counter}`, issues);

    if (
      [
        'costs',
        'spellAdditionalCosts',
        'additionalCost',
        'additionalCostPerChoiceBeyondFirst',
      ].includes(key) &&
      Array.isArray(entry)
    ) {
      entry.forEach((cost, index) => {
        try {
          validateCost(cost as AbilityCost, `${path}.${key}[${index}]`, issues);
        } catch {
          issues.push({ path: `${path}.${key}[${index}]`, message: 'unknown cost contract' });
        }
      });
    }
    if (
      key === 'modes' &&
      owningScope !== undefined &&
      entry !== null &&
      typeof entry === 'object'
    ) {
      const modes = entry as {
        minChoices: number;
        maxChoices: number;
        repeatable?: boolean;
        options: { targetSlots?: number[] }[];
      };
      if (!Array.isArray(modes.options)) {
        issues.push({ path: `${path}.modes`, message: 'mode options must be an array' });
        continue;
      }
      if (
        !integer(modes.minChoices) ||
        !integer(modes.maxChoices) ||
        modes.minChoices > modes.maxChoices ||
        (!modes.repeatable && modes.maxChoices > modes.options.length)
      )
        issues.push({ path: `${path}.modes`, message: 'invalid modal choice bounds' });
      for (const [index, option] of modes.options.entries()) {
        if (option === null || typeof option !== 'object') {
          issues.push({ path: `${path}.modes.options[${index}]`, message: 'invalid mode option' });
          continue;
        }
        const slots = option.targetSlots;
        if (slots !== undefined && !Array.isArray(slots)) {
          issues.push({
            path: `${path}.modes.options[${index}].targetSlots`,
            message: 'target slots must be an array',
          });
          continue;
        }
        if (
          slots !== undefined &&
          (new Set(slots).size !== slots.length ||
            slots.some((slot) => !integer(slot) || owningScope!.targets[slot] === undefined))
        )
          issues.push({
            path: `${path}.modes.options[${index}].targetSlots`,
            message: 'invalid mode target-slot ownership',
          });
        if (slots !== undefined) {
          for (const slot of slots) {
            const dependency = owningScope.targets[slot]?.graveyardOwnerSlot;
            if (dependency !== undefined && !slots.includes(dependency))
              issues.push({
                path: `${path}.modes.options[${index}].targetSlots`,
                message: 'mode must own its graveyard owner dependency',
              });
          }
        }
        visit(option, `${path}.modes.options[${index}]`, issues, {
          ...owningScope,
          ...(slots === undefined ? {} : { activeSlots: slots }),
        });
      }
    } else if (
      key === 'then' &&
      record['op'] === 'conditionalEffect' &&
      owningScope !== undefined &&
      typeof record['checkTarget'] === 'number' &&
      (record['condition'] as { kind?: string } | undefined)?.kind === 'triggerObjectMatches'
    ) {
      // Only the checked slot in this branch can be a battlefield permanent.
      visit(entry, `${path}.${key}`, issues, {
        ...owningScope,
        narrowedDomains: new Map([
          ...(owningScope.narrowedDomains ?? []),
          [record['checkTarget'], ['permanent'] as const],
        ]),
      });
    } else {
      if (
        ['spellAbility', 'ability'].includes(key) &&
        entry !== null &&
        typeof entry === 'object' &&
        (!Array.isArray((entry as Record<string, unknown>)['targets']) ||
          !Array.isArray((entry as Record<string, unknown>)['effects']))
      ) {
        issues.push({
          path: `${path}.${key}`,
          message: 'ability requires target and effect arrays',
        });
        continue;
      }
      if (key === 'effects' && Array.isArray(entry)) {
        entry.forEach((effect, index) => {
          if (
            effect === null ||
            typeof effect !== 'object' ||
            typeof (effect as { op?: unknown }).op !== 'string'
          )
            issues.push({
              path: `${path}.${key}[${index}]`,
              message: 'effect requires a known operation',
            });
        });
      }
      visit(entry, `${path}.${key}`, issues, owningScope);
    }
  }
}

/** Validate the fully merged executable definition rather than trusting an override patch alone. */
export function validateCardDefinition(definition: CardDefinition): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  if (!validateIRGraph(definition, 'definition', issues)) return issues;
  for (const field of [
    'types',
    'supertypes',
    'subtypes',
    'colors',
    'colorIdentity',
    'keywords',
    'manaAbilities',
    'activatedAbilities',
    'triggers',
    'staticEffects',
    'ruleStatics',
  ] as const)
    if (!Array.isArray(definition[field]))
      issues.push({ path: `definition.${field}`, message: `${field} must be an array` });
  if (definition.manaCost !== null)
    validateManaCost(definition.manaCost, 'definition.manaCost', issues);
  if (!definition.modeled || definition.unmodeledReasons.length > 0)
    issues.push({
      path: 'definition',
      message: `card is not fully modeled: ${definition.unmodeledReasons.join('; ')}`,
    });
  if (!supportsAdditionalXAnnouncement(definition))
    issues.push({
      path: 'definition.announcesX',
      message: 'additional X requires a direct pay-X-life cost',
    });
  visit(definition, 'definition', issues);
  validateFields(definition, 'definition', issues);
  return issues;
}

/** Invalid parser/override output remains explicitly unsupported, with the exact violated contract. */
export function enforceCardDefinition(definition: CardDefinition): CardDefinition {
  if (!definition.modeled) return definition;
  const issues = validateCardDefinition(definition);
  if (issues.length === 0) return definition;
  return {
    ...definition,
    modeled: false,
    unmodeledReasons: [
      ...definition.unmodeledReasons,
      ...issues.map((issue) => `Invalid ability IR at ${issue.path}: ${issue.message}`),
    ],
  };
}

/** Custom/token definitions cannot enter a game with a false executable support claim. */
export function assertValidModeledDefinition(definition: CardDefinition): CardDefinition {
  if (definition.modeled) {
    const issues = validateCardDefinition(definition);
    if (issues.length > 0)
      throw new Error(
        `Invalid card definition ${definition.name}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      );
  }
  return definition;
}

/** Validate authored data before it is merged with parser output. */
export function validateOverrideDefinition(override: CardOverride): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  if (!validateIRGraph(override.def, 'override.def', issues)) return issues;
  if (override.unsupportedReason === undefined) {
    visit(override.def, 'override.def', issues);
    validateFields(override.def, 'override.def', issues);
  }
  return issues;
}
