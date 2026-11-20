import {
  assertDelayedTriggerEvent,
  validateTriggerHead,
  triggerProvidesEventPlayer,
} from './trigger-contracts';
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
import { layerEvaluable, manaAmountEvaluable } from './value';
import type { Value } from './value';
import { TOKEN_OPS_ACTING_FIRST, tokenCharacteristicFixed } from './tokens';
import { TRIGGER_SCOPE_FIELDS, VALUE_SCOPE_NEEDS } from './scope-contracts';
import type { ScopeField } from './scope-contracts';

export interface AuthoringIssue {
  path: string;
  message: string;
}
interface Scope {
  targets: TargetSpec[];
  eventObject?: 'permanent' | 'card';
  /** The event object is the ability's own source — a `self` subject binds no event object id. */
  selfEventObject?: boolean;
  /** The owning trigger binds an attacking creature's defending player (an `attacks` event). */
  attackEventObject?: boolean;
  providedEventObject?: 'permanent' | 'card';
  eventPlayer?: boolean;
  providedEventPlayer?: boolean;
  /** `attackDeclared` firing with one group, and one attacked player, for each defender. */
  attackedPlayer?: boolean;
  movedToBattlefieldSlots?: ReadonlySet<number>;
  activeSlots?: readonly number[];
  narrowedDomains?: ReadonlyMap<number, readonly TargetDomain[]>;
  /** Scope fields this ability's trigger head, cast path or cost fills (ADR 0034). */
  scopeFields?: ReadonlySet<ScopeField>;
  /** Scope fields an enclosing construct gives a nested ability that has no trigger head. */
  providedScopeFields?: readonly ScopeField[];
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
  exiledWithSourceColors: true,
} satisfies Record<DynamicManaKind, true>;

function checkReference(
  value: unknown,
  path: string,
  contract: ReferenceContract,
  scope: Scope | undefined,
  issues: AuthoringIssue[],
): void {
  if (value === undefined && contract.optional === true) return;
  if (value !== null && typeof value === 'object') {
    // "Controller of target N": the player who controls the permanent in an ordinary slot.
    const inner = (value as { controllerOf?: unknown }).controllerOf;
    if (!contract.domains.includes('player'))
      issues.push({
        path,
        message: 'controller reference is incompatible with this effect domain',
      });
    else
      checkReference(
        inner,
        `${path}.controllerOf`,
        { domains: ['permanent'], selection: 'ordinary' },
        scope,
        issues,
      );
    return;
  }
  if (typeof value === 'string') {
    if (value === 'triggerObject' && scope?.eventObject === undefined) {
      issues.push({ path, message: 'event object reference has no owning event scope' });
      return;
    }
    if (contract.nonTargetRefs?.some((ref) => ref === value)) return;
    if (value === 'triggerObject' && scope?.eventObject === 'card') {
      issues.push({
        path,
        message: 'card event object is incompatible with this permanent reference',
      });
      return;
    }
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
      value >=
        scope.targets.filter(
          (target) => target !== null && typeof target === 'object' && target.count === undefined,
        ).length)
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
      spec.differentFromSlots !== undefined &&
      (!Array.isArray(spec.differentFromSlots) ||
        spec.differentFromSlots.length === 0 ||
        spec.count !== undefined ||
        spec.differentFromSlots.some(
          (other) => !integer(other) || other >= slot || targets[other]?.count !== undefined,
        ))
    )
      issues.push({
        path: `${at}.differentFromSlots`,
        message: 'another target requires earlier ordinary slots',
      });
    if (spec.differentPlayerTargetSlots !== undefined) {
      const others = spec.differentPlayerTargetSlots;
      if (
        spec.kind !== 'player' ||
        spec.count !== undefined ||
        spec.filter !== undefined ||
        !Array.isArray(others) ||
        others.length === 0 ||
        others.length !== targets.length - 1 ||
        new Set(others).size !== others.length ||
        others.some(
          (other) =>
            !integer(other) ||
            other === slot ||
            targets[other]?.kind !== 'player' ||
            targets[other]?.count !== undefined ||
            targets[other]?.filter !== undefined ||
            targets[other]?.controller !== spec.controller ||
            targets[other]?.controllerPlayer !== spec.controllerPlayer ||
            !targets[other]?.differentPlayerTargetSlots?.includes(slot),
        )
      )
        issues.push({
          path: `${at}.differentPlayerTargetSlots`,
          message:
            'distinct player targets require every other ordinary player slot in the same domain',
        });
    }
    if (
      spec.spellTargetsPermanentYouControl !== undefined &&
      (spec.spellTargetsPermanentYouControl !== true ||
        !['spell', 'noncreatureSpell'].includes(spec.kind))
    )
      issues.push({
        path: `${at}.spellTargetsPermanentYouControl`,
        message: 'permanent target restriction requires a stack spell target and true flag',
      });
    if (
      spec.spellHasSingleTarget !== undefined &&
      (spec.spellHasSingleTarget !== true ||
        !['spell', 'noncreatureSpell', 'stackObject'].includes(spec.kind))
    )
      issues.push({
        path: `${at}.spellHasSingleTarget`,
        message: 'single target restriction requires a stack target and true flag',
      });
    if (
      spec.stackTargetsYouOrCreatureYouControl !== undefined &&
      (spec.stackTargetsYouOrCreatureYouControl !== true ||
        !['spell', 'noncreatureSpell', 'stackObject'].includes(spec.kind))
    )
      issues.push({
        path: `${at}.stackTargetsYouOrCreatureYouControl`,
        message: 'you-or-your-creature restriction requires a stack target and true flag',
      });
    if (
      spec.stackKind !== undefined &&
      (spec.kind !== 'stackObject' ||
        !['spell', 'activatedAbility', 'triggeredAbility'].includes(spec.stackKind))
    )
      issues.push({
        path: `${at}.stackKind`,
        message: 'stack object kind requires a stackObject target and a known kind',
      });
    if (
      spec.controller !== undefined &&
      !['you', 'opponent', 'eventPlayer', 'activePlayer'].includes(spec.controller)
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
      spec.random !== undefined &&
      (spec.random !== true ||
        spec.kind !== 'cardInGraveyard' ||
        spec.count !== undefined ||
        spec.perPlayer !== undefined)
    )
      issues.push({
        path: `${at}.random`,
        message: 'random targets require a single graveyard card target',
      });
    if (spec.perPlayer !== undefined) {
      if (
        spec.perPlayer !== true ||
        spec.count?.min !== 0 ||
        spec.count.max !== 1 ||
        (spec.controller !== undefined && spec.controller !== 'opponent') ||
        spec.controllerPlayer !== undefined ||
        spec.slotGroup !== undefined ||
        !knownDomain ||
        !targetDomains(spec.kind).includes('permanent') ||
        slot !== targets.length - 1
      )
        issues.push({
          path: `${at}.perPlayer`,
          message:
            'a per-player target must be the last slot, an optional (0 to 1) battlefield permanent with either no controller restriction or opponents only',
        });
    } else if (spec.controllerPlayer !== undefined || spec.slotGroup !== undefined) {
      issues.push({
        path: at,
        message: 'a player-bound slot is only produced by expanding a per-player target',
      });
    }
    if (
      spec.totalManaValueAtMost !== undefined &&
      (!integer(spec.totalManaValueAtMost) ||
        spec.count === undefined ||
        !knownDomain ||
        !targetDomains(spec.kind).some(
          (domain) => domain === 'permanent' || domain === 'graveyard',
        ))
    )
      issues.push({
        path: at,
        message: 'collective mana value requires a counted battlefield or graveyard target',
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
    case 'removeCountersFromAmong':
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
    case 'returnUnblockedAttacker':
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

/** Ops that pay energy and record the amount in the resolution scope as `energyPaid`. */
const ENERGY_PAYMENT_OPS: ReadonlySet<string> = new Set(['mayPayEnergy', 'mayPayEnergyUpTo']);

function triggerScopeFields(when: unknown, aggregate: unknown): ScopeField[] {
  const fields =
    typeof when === 'string' && Object.hasOwn(TRIGGER_SCOPE_FIELDS, when)
      ? [...TRIGGER_SCOPE_FIELDS[when as keyof typeof TRIGGER_SCOPE_FIELDS]]
      : [];
  if (aggregate !== undefined && aggregate !== false) fields.push('triggerCount');
  return fields;
}

/**
 * What an ability's scope carries when it resolves: its trigger head's facts, a spell's own cast
 * (`casting/cast.ts`), or, for an ability with no head of its own (a reflexive or delayed body),
 * what the enclosing construct gives it.
 */
function abilityScopeFields(
  record: Record<string, unknown>,
  trigger: { when?: string } | undefined,
  scope: Scope | undefined,
): ReadonlySet<ScopeField> {
  const fields = new Set<ScopeField>(
    trigger === undefined ? (scope?.providedScopeFields ?? scope?.scopeFields ?? []) : [],
  );
  if (record['kind'] === 'triggered' && trigger !== undefined)
    for (const field of triggerScopeFields(
      trigger.when,
      (trigger as { aggregate?: unknown }).aggregate,
    ))
      fields.add(field);
  if (record['kind'] === 'spell') {
    fields.add('manaSpent');
    fields.add('treasureManaSpent');
  }
  return fields;
}

function visit(value: unknown, path: string, issues: AuthoringIssue[], scope?: Scope): void {
  if (Array.isArray(value)) {
    let currentScope = scope;
    value.forEach((entry, index) => {
      visit(entry, `${path}[${index}]`, issues, currentScope);
      if (currentScope === undefined || entry === null || typeof entry !== 'object') return;
      const effect = entry as Record<string, unknown>;
      // These ops write the energy paid into the resolution's shared scope, so every later effect
      // of the same list reads it too (`effects/resolve.ts`).
      if (ENERGY_PAYMENT_OPS.has(String(effect['op'])))
        currentScope = {
          ...currentScope,
          scopeFields: new Set([...(currentScope.scopeFields ?? []), 'energyPaid']),
        };
      if (
        ['commandZoneToBattlefield', 'graveyardToBattlefield'].includes(String(effect['op'])) &&
        typeof effect['target'] === 'number'
      )
        currentScope = {
          ...currentScope,
          movedToBattlefieldSlots: new Set([
            ...(currentScope.movedToBattlefieldSlots ?? []),
            effect['target'],
          ]),
        };
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record['op'] === 'registerDelayedTrigger') {
    try {
      assertDelayedTriggerEvent(record['when'] as import('./ability').TriggerWhen);
    } catch (error) {
      issues.push({
        path: `${path}.when`,
        message: error instanceof Error ? error.message : 'invalid delayed event',
      });
    }
    if (!['endStep', 'cleanup', 'onFire'].includes(record['expiry'] as string))
      issues.push({ path: `${path}.expiry`, message: 'invalid delayed trigger expiry' });
  }
  if (
    record['dynamic'] !== undefined &&
    (typeof record['dynamic'] !== 'string' || !Object.hasOwn(dynamicManaKinds, record['dynamic']))
  )
    issues.push({ path: `${path}.dynamic`, message: 'unknown dynamic mana kind' });
  if (
    record['kind'] === 'adventure' ||
    record['kind'] === 'omen' ||
    record['kind'] === 'split' ||
    (record['kind'] === 'mdfc' && record['spellFace'] !== undefined)
  ) {
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
    const trigger = record['trigger'] as { when?: string; subject?: { kind?: string } } | undefined;
    const eventObject =
      record['kind'] !== 'triggered'
        ? undefined
        : trigger === undefined
          ? scope?.providedEventObject
          : trigger.when === 'discardsCard'
            ? 'card'
            : trigger.subject?.kind !== 'permanent'
              ? undefined
              : ['putIntoGraveyardFromAnywhere', 'leavesGraveyard'].includes(trigger.when ?? '')
                ? 'card'
                : 'permanent';
    let eventPlayer = false;
    if (record['kind'] === 'triggered') {
      if (scope?.providedEventPlayer !== undefined) eventPlayer = scope.providedEventPlayer;
      else if (trigger !== undefined) {
        try {
          eventPlayer =
            triggerProvidesEventPlayer(trigger.when as import('./ability').TriggerWhen) ||
            // "Taps a land for mana": the player who activated the mana ability.
            (trigger.when === 'becomesTapped' &&
              (trigger as { forMana?: unknown }).forMana === true) ||
            // "That creature's controller": the dying permanent's last controller.
            (trigger.when === 'dies' &&
              (trigger as { subjectControllerIsEventPlayer?: unknown })
                .subjectControllerIsEventPlayer === true);
        } catch {
          // validateTriggerHead reports unsupported event heads.
        }
      }
    }
    const attackedPlayer =
      record['kind'] === 'triggered' &&
      (trigger as { when?: string; perDefender?: boolean } | undefined)?.when ===
        'attackDeclared' &&
      (trigger as { perDefender?: boolean }).perDefender === true;
    const attackEventObject =
      record['kind'] === 'triggered' &&
      trigger?.when === 'attacks' &&
      trigger.subject?.kind === 'permanent';
    owningScope = {
      targets,
      eventPlayer,
      ...(attackedPlayer ? { attackedPlayer } : {}),
      ...(eventObject === undefined ? {} : { eventObject }),
      ...(record['kind'] === 'triggered' && trigger?.subject?.kind === 'self'
        ? { selfEventObject: true }
        : {}),
      ...(attackEventObject ? { attackEventObject: true } : {}),
      scopeFields: abilityScopeFields(record, trigger, scope),
    };
  }
  const needed =
    typeof record['kind'] === 'string' && Object.hasOwn(VALUE_SCOPE_NEEDS, record['kind'])
      ? VALUE_SCOPE_NEEDS[record['kind'] as keyof typeof VALUE_SCOPE_NEEDS]
      : null;
  if (
    needed !== null &&
    owningScope?.scopeFields !== undefined &&
    !owningScope.scopeFields.has(needed)
  )
    issues.push({
      path,
      message: `${String(record['kind'])} reads ${needed}, which this ability's trigger, cast or cost does not provide`,
    });
  let checkedPermanentPossible = false;
  if (
    record['op'] === 'conditionalEffect' &&
    typeof record['checkTarget'] === 'number' &&
    owningScope !== undefined
  ) {
    owningScope = { ...owningScope };
    delete owningScope.eventObject;
    const target = owningScope.targets[record['checkTarget']];
    if (target !== undefined) {
      try {
        const domains = targetDomains(target.kind);
        checkedPermanentPossible = domains.includes('permanent');
        if (domains.length === 1 && checkedPermanentPossible) owningScope.eventObject = 'permanent';
      } catch {
        // validateTargets already reports unknown target domains.
      }
    }
  }
  if (record['trigger'] !== undefined)
    validateTriggerHead(record['trigger'], `${path}.trigger`, issues);
  if (typeof record['op'] === 'string') {
    const op = record['op'] as Effect['op'];
    validateEffectExpressions(record as unknown as Effect, path, issues);
    if (Object.hasOwn(record, 'recipient') && op !== 'gainControlTarget')
      issues.push({
        path: `${path}.recipient`,
        message: 'recipient is implemented only for gainControlTarget',
      });
    if (op === 'gainControlTarget') {
      const recipient = record['recipient'];
      if (recipient !== undefined) {
        if (recipient === null || typeof recipient !== 'object' || Array.isArray(recipient)) {
          issues.push({
            path: `${path}.recipient`,
            message: 'recipient must be { targetPlayer: number } or { chooseOpponent: true }',
          });
        } else {
          // Two disjoint recipient branches, exactly one per object. Naming both is ambiguous
          // (which controller wins?), naming neither has no recipient at all — an empty object
          // must not silently fall back to "the ability controller", which would read as an
          // authored-but-absent choice rather than a mistake.
          const r = recipient as Record<string, unknown>;
          const namesSlot = Object.prototype.hasOwnProperty.call(r, 'targetPlayer');
          const namesChoice = Object.prototype.hasOwnProperty.call(r, 'chooseOpponent');
          for (const key of Object.keys(r)) {
            if (key !== 'targetPlayer' && key !== 'chooseOpponent') {
              issues.push({
                path: `${path}.recipient`,
                message: 'recipient only supports targetPlayer or chooseOpponent',
              });
            }
          }
          if (namesSlot && namesChoice) {
            issues.push({
              path: `${path}.recipient`,
              message: 'recipient names targetPlayer and chooseOpponent; use exactly one branch',
            });
          } else if (namesSlot) {
            const slot = r['targetPlayer'];
            if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) {
              issues.push({
                path: `${path}.recipient.targetPlayer`,
                message: 'recipient targetPlayer must be a nonnegative integer slot',
              });
            } else
              checkReference(
                slot,
                `${path}.recipient.targetPlayer`,
                { domains: ['player'], selection: 'ordinary' },
                owningScope,
                issues,
              );
          } else if (namesChoice) {
            // `chooseOpponent` is a flag, not a slot: anything other than the boolean true is a
            // typo or a mistyped value, never a falsey branch to be ignored.
            if (r['chooseOpponent'] !== true) {
              issues.push({
                path: `${path}.recipient.chooseOpponent`,
                message: 'recipient chooseOpponent must be the boolean true',
              });
            }
          } else {
            issues.push({
              path: `${path}.recipient`,
              message: 'recipient must name targetPlayer or chooseOpponent',
            });
          }
        }
      }
    }
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
    valueKind === 'opponentNonHandSpellCostIncrease' &&
    (!Number.isSafeInteger(record['amount']) || (record['amount'] as number) < 0)
  )
    issues.push({
      path: `${path}.amount`,
      message: 'spell cost increase requires a nonnegative integer',
    });
  if (valueKind === 'spellCastLimit') {
    if (!['any', 'noncreature'].includes(record['category'] as string))
      issues.push({
        path: `${path}.category`,
        message: 'spell cast limit requires a supported category',
      });
    if (!Number.isSafeInteger(record['limit']) || (record['limit'] as number) < 0)
      issues.push({
        path: `${path}.limit`,
        message: 'spell cast limit requires a nonnegative integer',
      });
  }
  if (valueKind === 'suppressObjectTriggers' || valueKind === 'otherPermanentsEnterTapped') {
    validateExpression('selector', record['filter'], `${path}.filter`, issues);
    if (
      valueKind === 'suppressObjectTriggers' &&
      (!Array.isArray(record['events']) ||
        record['events'].length === 0 ||
        record['events'].some((event) => event !== 'enters' && event !== 'dies'))
    )
      issues.push({
        path: `${path}.events`,
        message: 'suppression supports enters and dies events only',
      });
  }
  if (valueKind === 'untapDuringOthersUntapSteps' && record['filter'] !== undefined)
    validateExpression('selector', record['filter'], `${path}.filter`, issues);
  if (valueKind === 'spellCostIncrease') {
    if (!Number.isSafeInteger(record['amount']) || (record['amount'] as number) < 1)
      issues.push({
        path: `${path}.amount`,
        message: 'spell cost increase requires a positive integer',
      });
    if (record['filter'] !== undefined)
      validateExpression('selector', record['filter'], `${path}.filter`, issues);
    for (const flag of ['opponentsOnly', 'exceptCastersTurn'])
      if (record[flag] !== undefined && record[flag] !== true)
        issues.push({ path: `${path}.${flag}`, message: `${flag} must be true when present` });
  }
  if (valueKind === 'blockRestriction') {
    validateExpression('selector', record['attackers'], `${path}.attackers`, issues);
    for (const key of ['onlyBy', 'notBy'])
      if (record[key] !== undefined)
        validateExpression('selector', record[key], `${path}.${key}`, issues);
    if (record['notByGreaterPower'] !== undefined && record['notByGreaterPower'] !== true)
      issues.push({
        path: `${path}.notByGreaterPower`,
        message: 'notByGreaterPower must be true when present',
      });
    const max = record['maxBlockers'];
    if (max !== undefined && (!Number.isSafeInteger(max) || (max as number) < 1))
      issues.push({
        path: `${path}.maxBlockers`,
        message: 'maxBlockers must be a positive integer',
      });
    if (
      record['onlyBy'] === undefined &&
      record['notBy'] === undefined &&
      record['notByGreaterPower'] === undefined &&
      max === undefined
    )
      issues.push({ path, message: 'block restriction restricts nothing' });
  }
  if (valueKind === 'castAsThoughFlash') {
    if (record['filter'] !== undefined)
      validateExpression('selector', record['filter'], `${path}.filter`, issues);
    if (record['allPlayers'] !== undefined && record['allPlayers'] !== true)
      issues.push({ path: `${path}.allPlayers`, message: 'allPlayers must be true when present' });
  }
  if (valueKind === 'damageReplacement' || valueKind === 'lifeGainReplacement') {
    // Exactly one of a factor of at least 2 ("double", "twice") or an addition of at least 1.
    const factor = record['factor'];
    const plus = record['plus'];
    const validFactor = Number.isSafeInteger(factor) && (factor as number) >= 2;
    const validPlus = Number.isSafeInteger(plus) && (plus as number) >= 1;
    if ((factor === undefined) === (plus === undefined) || (factor !== undefined && !validFactor))
      issues.push({
        path: `${path}.factor`,
        message: 'replacement requires either an integer factor of at least 2 or plus',
      });
    if (plus !== undefined && !validPlus)
      issues.push({ path: `${path}.plus`, message: 'replacement plus must be a positive integer' });
    if (valueKind === 'damageReplacement') {
      if (!['any', 'opponents', 'opponentPlayers'].includes(record['recipient'] as string))
        issues.push({
          path: `${path}.recipient`,
          message: 'damage replacement requires any, opponents or opponentPlayers',
        });
      if (record['sourceFilter'] !== undefined)
        validateExpression('selector', record['sourceFilter'], `${path}.sourceFilter`, issues);
      for (const flag of ['excludesSelf', 'permanentSource', 'noncombatOnly'])
        if (record[flag] !== undefined && record[flag] !== true)
          issues.push({ path: `${path}.${flag}`, message: `${flag} must be true when present` });
    }
  }
  if (valueKind === 'graveyardToExile') {
    if (!['all', 'opponents'].includes(record['scope'] as string))
      issues.push({
        path: `${path}.scope`,
        message: 'graveyard replacement requires all or opponents scope',
      });
    if (!['owner', 'controller'].includes(record['basis'] as string))
      issues.push({
        path: `${path}.basis`,
        message: 'graveyard replacement requires owner or controller basis',
      });
    if (typeof record['includeTokens'] !== 'boolean')
      issues.push({
        path: `${path}.includeTokens`,
        message: 'graveyard replacement requires explicit token handling',
      });
    if (
      record['creatureFromBattlefieldOnly'] !== undefined &&
      record['creatureFromBattlefieldOnly'] !== true
    )
      issues.push({
        path: `${path}.creatureFromBattlefieldOnly`,
        message: 'creature death restriction must be true when present',
      });
  }
  if (['discardTarget', 'discardEachPlayer'].includes(String(record['op']))) {
    if (record['atRandom'] !== undefined && record['atRandom'] !== true)
      issues.push({
        path: `${path}.atRandom`,
        message: 'random discard flag must be true when present',
      });
    if (record['op'] === 'discardEachPlayer') {
      if (!['all', 'opponents'].includes(record['scope'] as string))
        issues.push({
          path: `${path}.scope`,
          message: 'discard requires all players or opponents',
        });
      if (record['drawForDiscarded'] !== undefined && record['drawForDiscarded'] !== true)
        issues.push({
          path: `${path}.drawForDiscarded`,
          message: 'draw for discarded flag must be true when present',
        });
    }
  }
  if (
    record['op'] === 'millEachPlayer' &&
    !['all', 'opponents'].includes(record['scope'] as string)
  )
    issues.push({ path: `${path}.scope`, message: 'mill requires all players or opponents' });
  if (
    record['op'] === 'eachOpponentLosesLife' &&
    record['emptyHandOnly'] !== undefined &&
    record['emptyHandOnly'] !== true
  )
    issues.push({
      path: `${path}.emptyHandOnly`,
      message: 'empty hand restriction must be true when present',
    });
  if (record['op'] === 'exileGraveyardEventCard' && owningScope?.eventObject !== 'card')
    issues.push({ path, message: 'graveyard event exile requires an owning card-zone event' });
  if (
    record['op'] === 'graveyardToBattlefield' &&
    record['gainsHaste'] !== undefined &&
    record['gainsHaste'] !== true
  )
    issues.push({ path: `${path}.gainsHaste`, message: 'haste grant must be true when present' });
  if (
    record['op'] === 'createTokenForPlayer' &&
    record['opponentsOnly'] !== undefined &&
    record['opponentsOnly'] !== true
  )
    issues.push({
      path: `${path}.opponentsOnly`,
      message: 'opponent restriction must be true when present',
    });
  if (
    record['op'] === 'discardEachPlayer' &&
    record['nonlandMaySatisfyCount'] !== undefined &&
    (record['nonlandMaySatisfyCount'] !== true || record['atRandom'] !== undefined)
  )
    issues.push({
      path: `${path}.nonlandMaySatisfyCount`,
      message: 'nonland alternative requires chosen discards and a true flag',
    });
  if (
    record['kind'] === 'attackTax' &&
    record['includePlaneswalkers'] !== undefined &&
    record['includePlaneswalkers'] !== true
  )
    issues.push({
      path: `${path}.includePlaneswalkers`,
      message: 'planeswalker attack tax must be true when present',
    });
  if (record['op'] === 'addAttackRequirement') {
    if ((record['target'] === undefined) === (record['selector'] === undefined))
      issues.push({
        path,
        message: 'an attack requirement names either a target or a selector for its creatures',
      });
    if (
      !['untilYourNextTurn', 'endOfYourNextTurn', 'thisTurn', 'duringTheirNextTurn'].includes(
        String(record['duration']),
      )
    )
      issues.push({ path: `${path}.duration`, message: 'unsupported attack requirement duration' });
    const requirements = record['requirements'];
    const valid = (entry: unknown): boolean => {
      const rule = entry as Record<string, unknown> | null;
      return (
        rule !== null &&
        typeof rule === 'object' &&
        (rule['kind'] === 'anyAttack' ||
          (rule['kind'] === 'notPlayer' && rule['player'] === 'you') ||
          (rule['kind'] === 'player' && rule['player'] === 'eventPlayer'))
      );
    };
    if (
      !Array.isArray(requirements) ||
      (requirements.length === 0 && record['cantAttack'] !== 'you') ||
      !requirements.every(valid)
    )
      issues.push({
        path: `${path}.requirements`,
        message: 'an attack requirement needs at least one supported requirement',
      });
  }
  if (
    Array.isArray(record['targets']) &&
    record['targets'].some(
      (spec) => spec !== null && typeof spec === 'object' && 'differentPlayerTargetSlots' in spec,
    )
  ) {
    const modes = record['modes'] as { repeatable?: boolean } | undefined;
    if (record['kind'] !== 'triggered' || modes === undefined || modes.repeatable === true)
      issues.push({
        path,
        message: 'distinct player target slots require nonrepeatable triggered modes',
      });
  }
  if (
    record['op'] === 'sacrificeGreatestEachOpponent' &&
    record['damageIfGraveyardSpellsAtLeast'] !== undefined &&
    (record['action'] !== 'exile' ||
      record['metric'] !== 'power' ||
      record['selector'] !== 'creature')
  )
    issues.push({
      path,
      message: 'conditional greatest-power damage requires exiling creatures by power',
    });
  if (record['kind'] === 'attackRestriction') {
    if (record['includePlaneswalkers'] !== true)
      issues.push({
        path: `${path}.includePlaneswalkers`,
        message: 'an attack restriction covers planeswalkers and must say so',
      });
    const cost = record['cost'];
    if (
      cost !== undefined &&
      (cost === null ||
        typeof cost !== 'object' ||
        (cost as Record<string, unknown>)['perCounterOnCreature'] !== true)
    )
      issues.push({
        path: `${path}.cost`,
        message: 'an attack restriction cost must be per counter on the creature',
      });
  }
  if (
    [
      'transferCountersFromTriggerObject',
      'transferCountersFromTriggerObjectToChosenCreatures',
      'mayForgoTriggerObjectCombatDamageForRandomDiscard',
      'mayPayLifeForTriggerPowerAndCounter',
    ].includes(String(record['op'])) &&
    owningScope?.eventObject !== 'permanent'
  )
    issues.push({
      path,
      message: 'implicit event effect requires an owning permanent event scope',
    });
  if (
    [
      'eventPlayerDrawCount',
      'eventPlayerHandSize',
      'notFirstDrawInOwnDrawStep',
      'attackingEventPlayer',
    ].includes(String(valueKind)) &&
    owningScope?.eventPlayer !== true
  )
    issues.push({ path, message: 'event player information has no owning event player scope' });
  if (
    [
      'powerOfTriggerObject',
      'countersOnTriggerObject',
      'aurasYouControlledAttachedToTriggerObject',
      'triggerObjectMatches',
      'triggerObjectHadToAttackThisCombat',
      'triggerObjectAttackingOpponent',
      'defendingOpponentHasMoreLifeThanAnother',
    ].includes(String(valueKind)) &&
    owningScope?.eventObject !== 'permanent'
  )
    issues.push({
      path,
      message: 'event object information requires an owning permanent event scope',
    });
  if (valueKind === 'eventObjectDefendingPlayerIsYou') {
    if (owningScope?.eventObject !== 'permanent')
      issues.push({
        path,
        message: 'event object defending player check requires an owning permanent event scope',
      });
    else if (owningScope.attackEventObject !== true)
      issues.push({
        path,
        message: 'event object defending player check requires a creature attack event',
      });
  }
  if (record['op'] === 'unlessPays') {
    const payer = record['payer'];
    if (!['eventPlayer', 'controller', 'eventObjectController'].includes(payer as string))
      issues.push({ path: `${path}.payer`, message: 'unknown payer' });
    else if (payer === 'eventObjectController') {
      // A `self` subject binds no event object id, so there is no exact original permanent to
      // read a controller from at resolution; a card-scope event has no permanent at all.
      if (owningScope?.eventObject !== 'permanent' || owningScope.selfEventObject === true)
        issues.push({
          path: `${path}.payer`,
          message: 'event object controller payer requires an owning permanent event-object scope',
        });
    }
  }
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
  if (['powerOfTarget', 'countersOnTarget', 'manaValueOfTarget'].includes(String(valueKind))) {
    if (record['target'] === 'attachedToSource')
      issues.push({
        path: `${path}.target`,
        message: 'numeric attachment references have no supported lifetime contract',
      });
    checkReference(
      record['target'],
      `${path}.target`,
      {
        domains: valueKind === 'manaValueOfTarget' ? ['permanent', 'spell'] : ['permanent'],
        selection: 'ordinary',
      },
      owningScope,
      issues,
    );
  }

  // A token's printed power and toughness are fixed as the token is created. A token-creating
  // effect's own `spec` has its values read with the resolving ability's scope first
  // (`withTokenCharacteristicsFixed` in effects/resolve.ts), except an op that destroys, exiles,
  // mills or counters before it creates (`TOKEN_OPS_ACTING_FIRST`), which would read the game
  // before that change. Every other token spec (`tokenCreationReplacement`) reaches
  // `registerTokenDef`, which reads a value with no scope at all, so a value that needs one
  // throws in play, as Warden of the Grove's "X/X where X is the counters on this creature" did.
  // A card definition's own power is always a number, so an object here is a token's.
  if (typeof record['op'] === 'string' && isTokenSpec(record['spec']))
    checkTokenCharacteristics(
      record['spec'],
      `${path}.spec`,
      TOKEN_OPS_ACTING_FIRST.has(record['op'] as Effect['op']) ? 'fixed' : 'resolving',
      issues,
    );
  else if (isTokenSpec(record) && !path.endsWith('.spec'))
    checkTokenCharacteristics(record, path, 'fixed', issues);
  // "~ enters with a counter for each creature of the chosen type" (Banner of Kinship). An
  // entering permanent's counters and its enters-tapped condition are settled as it is built,
  // before its as-enters choice is made (state/objects.ts), so a chosen option read there would
  // never match and the count would always be zero.
  if (
    record['entersWithCounters'] !== null &&
    typeof record['entersWithCounters'] === 'object' &&
    !Array.isArray(record['entersWithCounters'])
  )
    for (const [counter, amount] of Object.entries(record['entersWithCounters'])) {
      if (amount !== null && typeof amount === 'object' && readsChosenOption(amount))
        issues.push({
          path: `${path}.entersWithCounters.${counter}`,
          message: CHOSEN_BEFORE_CHOICE,
        });
    }
  if (record['entersTappedUnless'] !== undefined && readsChosenOption(record['entersTappedUnless']))
    issues.push({ path: `${path}.entersTappedUnless`, message: CHOSEN_BEFORE_CHOICE });
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
  if (typeof record['units'] !== 'undefined' && record['amount'] !== undefined) {
    // Only a mana ability has `units`. Its amount is read with no resolving ability's scope.
    const before = issues.length;
    validateExpression('value', record['amount'], `${path}.amount`, issues);
    if (issues.length === before && !manaAmountEvaluable(record['amount'] as Value))
      issues.push({
        path: `${path}.amount`,
        message: 'mana amount a mana ability cannot evaluate',
      });
  }
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
    if (entry === 'eventPlayer' && owningScope?.eventPlayer !== true)
      issues.push({
        path: `${path}.${key}`,
        message: 'event player reference has no owning event player scope',
      });
    if (entry === 'attackedPlayer' && owningScope?.attackedPlayer !== true)
      issues.push({
        path: `${path}.${key}`,
        message: 'attacked player reference needs a per-defender attack declaration trigger',
      });
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
        if (key === 'activatedAbilities' && ability !== null && typeof ability === 'object') {
          const timing = (ability as { timing?: unknown }).timing;
          if (
            timing !== undefined &&
            (typeof timing !== 'string' || !['any', 'sorcery', 'yourTurn'].includes(timing))
          ) {
            issues.push({
              path: `${path}.${key}[${index}].timing`,
              message: 'activated timing must be any, sorcery, or yourTurn',
            });
          }
        }
        if (key === 'manaAbilities' && ability !== null && typeof ability === 'object')
          validateManaRiders(ability.onActivate, `${path}.${key}[${index}].onActivate`, issues);
      }
    }
    if (key === 'triggers' && Array.isArray(entry))
      entry.forEach((ability, index) => {
        if (ability?.kind !== 'triggered' || ability.trigger === undefined)
          issues.push({
            path: `${path}.${key}[${index}]`,
            message: 'trigger entry requires a triggered ability with an event head',
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
    if (
      ['condition', 'eventCondition', 'entersTappedUnless', 'castRestriction'].includes(key) &&
      entry !== undefined
    ) {
      const before = issues.length;
      validateExpression('condition', entry, `${path}.${key}`, issues);
      if (
        issues.length === before &&
        (key === 'condition' || key === 'eventCondition') &&
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
        optional?: true;
        options: { targetSlots?: number[] }[];
      };
      if (!Array.isArray(modes.options)) {
        issues.push({ path: `${path}.modes`, message: 'mode options must be an array' });
        continue;
      }
      if (
        modes.optional !== undefined &&
        (modes.optional !== true || record['kind'] !== 'triggered')
      )
        issues.push({
          path: `${path}.modes.optional`,
          message: 'optional fixed modal choices require a triggered ability and true flag',
        });
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
      checkedPermanentPossible &&
      (record['condition'] as { kind?: string } | undefined)?.kind === 'triggerObjectMatches'
    ) {
      // Only the checked slot in this branch can be a battlefield permanent.
      visit(entry, `${path}.${key}`, issues, {
        ...owningScope,
        eventObject: 'permanent',
        narrowedDomains: new Map([
          ...(owningScope.narrowedDomains ?? []),
          [record['checkTarget'], ['permanent'] as const],
        ]),
      });
    } else if (
      key === 'condition' &&
      record['op'] === 'conditionalEffect' &&
      checkedPermanentPossible &&
      (entry as { kind?: string } | undefined)?.kind === 'triggerObjectMatches' &&
      owningScope !== undefined
    ) {
      visit(entry, `${path}.${key}`, issues, { ...owningScope, eventObject: 'permanent' });
    } else if (key === 'ability' && record['op'] === 'registerDelayedTrigger') {
      const target = record['target'];
      let providedEventObject: Scope['providedEventObject'];
      if (target === 'triggerObject') providedEventObject = owningScope?.eventObject;
      else if (target === 'source' || target === 'attachedToSource')
        providedEventObject = 'permanent';
      else if (typeof target === 'number') {
        const spec = owningScope?.targets[target];
        if (spec !== null && typeof spec === 'object') {
          try {
            const domains = targetDomains(spec.kind);
            if (
              owningScope?.movedToBattlefieldSlots?.has(target) ||
              (domains.length === 1 && domains[0] === 'permanent')
            )
              providedEventObject = 'permanent';
            else if (domains.length === 1 && domains[0] === 'graveyard')
              providedEventObject = 'card';
          } catch {
            // validateTargets reports malformed target domains without aborting validation.
          }
        }
      }
      visit(entry, `${path}.${key}`, issues, {
        targets: [],
        providedEventPlayer: record['affectedPlayer'] !== undefined,
        providedScopeFields: triggerScopeFields(record['when'], undefined),
        ...(providedEventObject === undefined ? {} : { providedEventObject }),
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
      visit(entry, `${path}.${key}`, issues, nestedScope(record, key, owningScope));
    }
  }
}

const CHOSEN_BEFORE_CHOICE =
  'an entering permanent settles its counters and enters-tapped condition before its as-enters choice; a chosen option cannot be read here';

/** Selectors and conditions that read the source's as-enters `chosenOption`. */
const CHOSEN_OPTION_KINDS = new Set([
  'chosenColor',
  'chosenType',
  'chosenSubtype',
  'attackingChosenPlayer',
  'chosenOptionIs',
]);

function readsChosenOption(value: unknown): boolean {
  return containsKind(value, CHOSEN_OPTION_KINDS);
}

function containsKind(value: unknown, kinds: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKind(entry, kinds));
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record['kind'] === 'string' && kinds.has(record['kind'])) return true;
  return Object.values(record).some((entry) => containsKind(entry, kinds));
}

function isTokenSpec(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['typeLine'] === 'string'
  );
}

/** Values a resolving ability cannot read: they exist only per affected object in a layer. */
const LAYER_ONLY_VALUES = new Set(['timesAttackedThisTurn']);

function checkTokenCharacteristics(
  spec: Record<string, unknown>,
  path: string,
  readWith: 'fixed' | 'resolving',
  issues: AuthoringIssue[],
): void {
  for (const field of ['power', 'toughness']) {
    const operand = spec[field];
    if (operand === null || typeof operand !== 'object') continue;
    // A malformed value is reported by the capability IR check; judge only a well-formed one.
    const shape: AuthoringIssue[] = [];
    validateExpression('value', operand, `${path}.${field}`, shape);
    if (shape.length > 0) continue;
    if (readWith === 'fixed' && !tokenCharacteristicFixed(operand as Value))
      issues.push({
        path: `${path}.${field}`,
        message:
          'this token power and toughness are read with no ability scope (a token spec outside an effect, or an op that changes the game before it creates); only a fixed value fits here',
      });
    else if (readWith === 'resolving' && containsKind(operand, LAYER_ONLY_VALUES))
      issues.push({
        path: `${path}.${field}`,
        message: 'a token power and toughness cannot read a value that exists only in a layer',
      });
  }
}

/**
 * The scope a nested ability inherits from the construct around it: a station cost's tapped
 * power for its activated ability (`actions/apply.ts`), and the energy actually paid for the
 * body of an energy payment (`effects/resolve.ts`).
 */
function nestedScope(
  record: Record<string, unknown>,
  key: string,
  owningScope: Scope | undefined,
): Scope | undefined {
  if (
    key === 'ability' &&
    Array.isArray(record['costs']) &&
    record['costs'].some(
      (cost) =>
        (cost as { kind?: unknown; capturePowerForStation?: unknown } | null)?.kind ===
          'tapOther' &&
        (cost as { capturePowerForStation?: unknown }).capturePowerForStation === true,
    )
  )
    return { ...(owningScope ?? { targets: [] }), providedScopeFields: ['stationPower'] };
  if (key === 'then' && ENERGY_PAYMENT_OPS.has(String(record['op'])) && owningScope !== undefined)
    return {
      ...owningScope,
      scopeFields: new Set([...(owningScope.scopeFields ?? []), 'energyPaid']),
    };
  if (key === 'then' && record['op'] === 'mayPayEnergyThenReflexive' && owningScope !== undefined)
    return {
      ...owningScope,
      providedScopeFields: [...(owningScope.scopeFields ?? []), 'energyPaid'],
    };
  return owningScope;
}

/** Ops whose actual life loss feeds a following `gainLifeEqualToLifeLostThisWay`. */
const LIFE_LOST_THIS_WAY_FEEDERS: ReadonlySet<Effect['op']> = new Set([
  'eachOpponentLosesLife',
  'loseLifeTarget',
  'loseHalfLifeTarget',
]);

function isEffectList(value: unknown[]): value is Effect[] {
  return (
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { op?: unknown }).op === 'string',
    )
  );
}

/**
 * Every reference from one effect to another must resolve within the scope the executor has
 * (ADR 0034 decision 2). `executeAbility` starts each effect list, including every nested body,
 * with fresh bindings and a zero "life lost this way" accumulator, so a reference resolves only
 * to an earlier effect of the same list. A bind or loss inside a nested body (a conditional
 * branch, a mode, a per-player body) is not visible after it.
 */
function validateEffectReferences(value: unknown, path: string, issues: AuthoringIssue[]): void {
  if (Array.isArray(value)) {
    if (isEffectList(value)) {
      const bound = new Set<string>();
      let lifeLossBefore = false;
      value.forEach((effect, index) => {
        if (effect.op === 'untapBoundIf' && !bound.has(effect.binding))
          issues.push({
            path: `${path}[${index}].binding`,
            message: `binding "${effect.binding}" is not bound by an earlier effect in the same effect list`,
          });
        if (effect.op === 'gainLifeEqualToLifeLostThisWay' && !lifeLossBefore)
          issues.push({
            path: `${path}[${index}]`,
            message:
              'life lost this way needs an earlier eachOpponentLosesLife, loseLifeTarget or loseHalfLifeTarget in the same effect list',
          });
        if (
          (effect.op === 'searchLibrary' || effect.op === 'searchLibraryGroup') &&
          effect.bind !== undefined
        )
          bound.add(effect.bind);
        if (LIFE_LOST_THIS_WAY_FEEDERS.has(effect.op)) lifeLossBefore = true;
      });
    }
    value.forEach((entry, index) => validateEffectReferences(entry, `${path}[${index}]`, issues));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value))
    validateEffectReferences(entry, `${path}.${key}`, issues);
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
  // A static's power and toughness are read by the layer engine, which answers only board values
  // (`layerEvaluable`); any other value would throw as layers are applied.
  if (Array.isArray(definition.staticEffects))
    definition.staticEffects.forEach((effect, index) => {
      const op = effect.op as { power?: unknown; toughness?: unknown };
      for (const key of ['power', 'toughness'] as const) {
        const value = op[key];
        if (value !== undefined && typeof value === 'object' && !layerEvaluable(value as Value))
          issues.push({
            path: `definition.staticEffects[${index}].op.${key}`,
            message: 'static value the layer engine cannot evaluate',
          });
      }
    });
  if (definition.gift !== undefined && !['treasure', 'card', 'extraTurn'].includes(definition.gift))
    issues.push({ path: 'definition.gift', message: 'unsupported gift kind' });
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
  validateEffectReferences(definition, 'definition', issues);
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
