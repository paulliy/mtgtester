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

function visit(value: unknown, path: string, issues: AuthoringIssue[], scope?: Scope): void {
  if (Array.isArray(value)) {
    let currentScope = scope;
    value.forEach((entry, index) => {
      visit(entry, `${path}[${index}]`, issues, currentScope);
      if (currentScope === undefined || entry === null || typeof entry !== 'object') return;
      const effect = entry as Record<string, unknown>;
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
              (trigger as { forMana?: unknown }).forMana === true);
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
    };
  }
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
