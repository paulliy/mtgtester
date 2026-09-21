import type { CardDefinition } from './definition';
import type { CardOverride } from './overrides';

export interface AuthoringIssue {
  path: string;
  message: string;
}

const EFFECT_REF_KEYS = new Set(['target', 'first', 'second', 'a']);
const TARGET_SLOT_KEYS = new Set(['targetSlot', 'cardsSlot', 'playerSlot', 'bSlot']);

function visit(
  value: unknown,
  path: string,
  issues: AuthoringIssue[],
  targetCounts?: { ordinary: number; total: number },
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, issues, targetCounts));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  let nestedTargetCounts = targetCounts;
  if (
    typeof record['kind'] === 'string' &&
    ['spell', 'triggered', 'activated'].includes(record['kind']) &&
    Array.isArray(record['targets']) &&
    Array.isArray(record['effects'])
  ) {
    const targets = record['targets'] as { count?: unknown }[];
    const firstCounted = targets.findIndex((target) => target.count !== undefined);
    if (
      firstCounted >= 0 &&
      targets.slice(firstCounted).some((target) => target.count === undefined)
    ) {
      issues.push({
        path: `${path}.targets`,
        message: 'variable-count target slots must follow every ordinary target slot',
      });
    }
    nestedTargetCounts = {
      ordinary: targets.filter((target) => target.count === undefined).length,
      total: targets.length,
    };
  }

  if (record['op'] === 'noOp') {
    issues.push({
      path,
      message: 'executable noOp effects are prohibited; keep the card unsupported instead',
    });
  }

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'number' && EFFECT_REF_KEYS.has(key) && nestedTargetCounts !== undefined) {
      if (!Number.isInteger(entry) || entry < 0 || entry >= nestedTargetCounts.ordinary) {
        issues.push({
          path: `${path}.${key}`,
          message: `effect target ${entry} does not reference an ordinary target slot`,
        });
      }
    }
    if (
      typeof entry === 'number' &&
      TARGET_SLOT_KEYS.has(key) &&
      nestedTargetCounts !== undefined
    ) {
      if (!Number.isInteger(entry) || entry < 0 || entry >= nestedTargetCounts.total) {
        issues.push({
          path: `${path}.${key}`,
          message: `target slot ${entry} is outside the ability target list`,
        });
      }
    }
    visit(entry, `${path}.${key}`, issues, nestedTargetCounts);
  }
}

/** Validate the fully merged executable definition rather than trusting an override patch alone. */
export function validateCardDefinition(definition: CardDefinition): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  if (!definition.modeled || definition.unmodeledReasons.length > 0) {
    issues.push({
      path: 'definition',
      message: `card is not fully modeled: ${definition.unmodeledReasons.join('; ')}`,
    });
  }
  visit(definition, 'definition', issues);
  return issues;
}

/** Validate authored data before it is merged with parser output. */
export function validateOverrideDefinition(override: CardOverride): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  if (override.unsupportedReason === undefined) visit(override.def, 'override.def', issues);
  return issues;
}
