import { describe, expect, it } from 'vitest';
import type { CardOverride } from '../src/cards/overrides';
import {
  enforceCardDefinition,
  validateCardDefinition,
  validateOverrideDefinition,
} from '../src/cards/authoring-validation';
import { validateExpression } from '../src/cards/expression-validation';
import { validateIRGraph } from '../src/cards/ir-graph';
import { interpretCard } from '../src/cards/interpret';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { bear } from './fixtures';

describe('bounded authoring IR graph contracts', () => {
  it.each(['selector', 'value', 'condition'] as const)(
    'rejects cyclic %s before recursive semantics',
    (domain) => {
      const cycle: Record<string, unknown> = { kind: domain === 'value' ? 'negate' : 'not' };
      cycle['of'] = cycle;
      const issues: AuthoringIssue[] = [];
      validateExpression(domain, cycle, domain, issues);
      expect(issues).toEqual([{ path: `${domain}.of`, message: 'cyclic IR graph' }]);
    },
  );

  it('rejects cycles in a merged definition and contains its executable claim', () => {
    const definition = structuredClone(interpretCard(bear()));
    const cycle: unknown[] = [];
    cycle.push(cycle);
    Object.assign(definition, { triggers: cycle });
    expect(validateCardDefinition(definition)[0]?.message).toBe('cyclic IR graph');
    const contained = enforceCardDefinition(definition);
    expect(contained.modeled).toBe(false);
    expect(contained.unmodeledReasons[0]).toContain('cyclic IR graph');
  });

  it('rejects cyclic override data before it can be merged', () => {
    const def: Record<string, unknown> = {};
    def['spellAbility'] = def;
    const override = { def } as unknown as CardOverride;
    expect(validateOverrideDefinition(override)).toEqual([
      { path: 'override.def.spellAbility', message: 'cyclic IR graph' },
    ]);
  });

  it('accepts shared acyclic expression nodes and validates each occurrence', () => {
    const leaf = { kind: 'powerAtLeast', n: 2 };
    const expression = { kind: 'allOf', of: [leaf, leaf] };
    const issues: AuthoringIssue[] = [];
    validateExpression('selector', expression, 'selector', issues);
    expect(issues).toEqual([]);
    leaf.n = Number.NaN;
    validateExpression('selector', expression, 'selector', issues);
    expect(issues).toHaveLength(2);
  });

  it('rejects excessive nesting before exhausting the call stack', () => {
    let value: unknown = { kind: 'const', n: 1 };
    for (let i = 0; i < 1000; i++) value = { kind: 'negate', of: value };
    const issues: AuthoringIssue[] = [];
    validateExpression('value', value, 'value', issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('budget');
  });

  it('counts primitive leaves in wide arrays against the graph budget', () => {
    const issues: AuthoringIssue[] = [];
    expect(
      validateIRGraph(
        Array.from({ length: 100_000 }, () => 'leaf'),
        'root',
        issues,
      ),
    ).toBe(false);
    expect(issues[0]?.message).toContain('budget');
  });

  it('bounds repeated node occurrences while allowing normal shared data', () => {
    const leaf = {};
    const issues: AuthoringIssue[] = [];
    expect(
      validateIRGraph(
        Array.from({ length: 100_000 }, () => leaf),
        'root',
        issues,
      ),
    ).toBe(false);
    expect(issues[0]?.message).toContain('budget');
    expect(
      validateIRGraph(
        Array.from({ length: 100 }, () => leaf),
        'root',
        [],
      ),
    ).toBe(true);
  });
});
