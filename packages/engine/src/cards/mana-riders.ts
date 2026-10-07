import type { ManaRider } from './ability';
import type { AuthoringIssue } from './authoring-validation';
import { validateExpression } from './expression-validation';
import { validateIRGraph } from './ir-graph';
import { needsScope, type Value } from './value';
import { UnmodeledCardError } from '../errors';
import { assertNever } from '../utils/assert-never';

type Fields<T> = Record<keyof T, true>;
const fields = {
  damageController: { op: true, amount: true } satisfies Fields<
    Extract<ManaRider, { op: 'damageController' }>
  >,
  gainLife: { op: true, amount: true } satisfies Fields<Extract<ManaRider, { op: 'gainLife' }>>,
  putCounters: { op: true, target: true, counter: true, count: true } satisfies Fields<
    Extract<ManaRider, { op: 'putCounters' }>
  >,
} satisfies Record<ManaRider['op'], object>;

/** A mana ability has no target, choice, or ability scope and cannot suspend its resolution. */
export function validateManaRiders(riders: unknown, path: string, issues: AuthoringIssue[]): void {
  if (riders === undefined) return;
  if (!validateIRGraph(riders, path, issues)) return;
  if (!Array.isArray(riders)) {
    issues.push({ path, message: 'mana riders must be an array' });
    return;
  }
  const nonnegative = (value: unknown, at: string) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      issues.push({ path: at, message: 'mana rider amount must be a nonnegative integer' });
  };
  const scopeFree = (value: unknown, at: string) => {
    const before = issues.length;
    validateExpression('value', value, at, issues);
    if (issues.length === before && needsScope(value as Value))
      issues.push({ path: at, message: 'mana rider value requires an unavailable ability scope' });
  };
  for (const [index, rider] of riders.entries()) {
    const at = `${path}[${index}]`;
    if (rider === null || typeof rider !== 'object' || !Object.hasOwn(fields, rider.op)) {
      issues.push({ path: at, message: 'unsupported immediate mana rider effect' });
      continue;
    }
    const shape = fields[rider.op as ManaRider['op']];
    for (const key of Object.keys(rider))
      if (!Object.hasOwn(shape, key))
        issues.push({ path: `${at}.${key}`, message: 'unknown mana rider field' });
    const effect = rider as ManaRider;
    switch (effect.op) {
      case 'damageController':
        nonnegative(effect.amount, `${at}.amount`);
        break;
      case 'gainLife':
        scopeFree(effect.amount, `${at}.amount`);
        break;
      case 'putCounters':
        if (effect.target !== 'source')
          issues.push({
            path: `${at}.target`,
            message: 'mana rider counters must refer to the source',
          });
        if (typeof effect.counter !== 'string' || effect.counter.length === 0)
          issues.push({ path: `${at}.counter`, message: 'mana rider counter must be named' });
        if (typeof effect.count === 'number') nonnegative(effect.count, `${at}.count`);
        else scopeFree(effect.count, `${at}.count`);
        break;
      default:
        assertNever(effect, 'mana rider authoring');
    }
  }
}

export function assertManaRiders(
  name: string,
  riders: unknown,
): asserts riders is readonly ManaRider[] | undefined {
  const issues: AuthoringIssue[] = [];
  validateManaRiders(riders, 'manaAbility.onActivate', issues);
  if (issues.length)
    throw new UnmodeledCardError(
      name,
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      'activating a mana ability',
    );
}
