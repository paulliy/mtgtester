import type { Ability } from './ability';
import { EFFECT_REFERENCE_CONTRACTS } from './effect-reference-contracts';

/**
 * References inside conditional/choice instructions retain the same event object as direct
 * instructions (CR 400.7). A nested ability/token is a separate scope and is not executed here.
 */
export function actsOnItsTriggerObject(ability: Ability): boolean {
  function visit(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const op = record['op'];
    if (typeof op === 'string' && Object.hasOwn(EFFECT_REFERENCE_CONTRACTS, op)) {
      const fields = EFFECT_REFERENCE_CONTRACTS[op as keyof typeof EFFECT_REFERENCE_CONTRACTS];
      if (Object.keys(fields).some((field) => record[field] === 'triggerObject')) return true;
    }
    return Object.entries(record).some(
      ([key, child]) => key !== 'ability' && key !== 'spec' && visit(child),
    );
  }
  return visit(ability.effects);
}
