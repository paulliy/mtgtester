import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `RuleStatic` kind the parser can PRODUCE must be CONSUMED somewhere.
 *
 * A rule static is not executed by a switch the way an `Effect` op is — it is looked up ad hoc,
 * wherever the rule it modifies lives (cost reduction in `legal.ts`, "can't be countered" in
 * `stack.ts`, mana riders in `queries.ts`). There is no single place a missing consumer would
 * show up, and no type error when one is absent.
 *
 * `{ kind: 'kicker' }` was in exactly that state: parsed from the card, pushed into
 * `ruleStatics`, and read by nothing. `EnginePermanent.kicked`/`wasKicked` were never assigned,
 * so the `wasKicked` Condition was permanently false and every "if this spell was kicked" clause
 * silently took the not-kicked branch — while the card reported `modeled: true`.
 *
 * Production and consumption are checked separately, because the pairing is what matters:
 * a kind that is declared but neither produced nor consumed is harmless dead shape, while one
 * that is produced and not consumed is a card that lies about being modeled.
 */
const ENGINE_SRC = join(import.meta.dirname, '..', 'src');

/** Files that only ever declare or emit rule statics; a mention there is not consumption. */
const PRODUCER_FILES = new Set(['rule-statics.ts', 'interpret.ts', 'templates.ts']);

/**
 * Kinds knowingly declared without a consumer, and why. Anything here must also be absent from
 * the producers — that pairing is the actual invariant, and it is asserted below.
 */
const DECLARED_WITHOUT_CONSUMER: Record<string, string> = {
  kicker:
    'Kicker fails closed (see the block comment in interpret.ts). The member, the state fields ' +
    'and the wasKicked Condition are kept as the right shape for a real implementation; nothing ' +
    'produces it, so no card can claim to be modeled on the strength of it.',
};

/**
 * Kinds whose consumer discriminates on a SIBLING union member rather than on this kind's own
 * string, so a literal search cannot see them.
 */
const CONSUMED_BY_ELSE_BRANCH: Record<string, string> = {
  oneOfProducedTypes:
    "manaActivationRider.add is a two-member union; queries.ts branches on `add.kind === 'fixed'` " +
    'and handles this one in the else. Consumed, just never named.',
};

/**
 * Strip comments before scanning. A block comment EXPLAINING why a kind is not produced reads
 * as a production to a text search — which is exactly what happened the first time this guard
 * ran green-then-red. Only whole comment lines and block comments are removed, never a trailing
 * `//` (which could sit inside a string literal).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

function collectConsumerSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'overrides') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectConsumerSources(path, out);
    else if (entry.name.endsWith('.ts') && !PRODUCER_FILES.has(entry.name)) {
      out.push(stripComments(readFileSync(path, 'utf8')));
    }
  }
  return out;
}

function declaredKinds(): string[] {
  const source = readFileSync(join(ENGINE_SRC, 'cards', 'rule-statics.ts'), 'utf8');
  return [...source.matchAll(/kind:\s*'([A-Za-z0-9_]+)'/g)].map((match) => match[1] as string);
}

describe('rule static coverage', () => {
  it('has a consumer for every RuleStatic kind declared', () => {
    const declared = new Set(declaredKinds());
    expect(declared.size).toBeGreaterThan(20);

    const consumers = collectConsumerSources(ENGINE_SRC).join('\n');

    const unconsumed = [...declared]
      .filter((kind) => kind in DECLARED_WITHOUT_CONSUMER === false)
      .filter((kind) => kind in CONSUMED_BY_ELSE_BRANCH === false)
      // Match on the KIND STRING, not on a field name. `manaActivationRider` is consulted as
      // `rider.add.kind` in `queries.ts`, so a field-name search would miss it; a bare
      // identifier search would produce false positives from unrelated locals.
      .filter((kind) => !new RegExp(`'${kind}'`).test(consumers))
      .sort();

    expect(
      unconsumed,
      'These RuleStatic kinds are declared and pushed by the parser but read by nothing, so the ' +
        'rule they describe silently never applies while the card reports modeled. Implement the ' +
        'consumer, or delete the parser rule so the card fails closed.',
    ).toEqual([]);
  });

  it('produces nothing it cannot consume', () => {
    const producers = [...PRODUCER_FILES]
      .filter((file) => file !== 'rule-statics.ts')
      .map((file) => stripComments(readFileSync(join(ENGINE_SRC, 'cards', file), 'utf8')))
      .join('\n');

    const leaked = Object.keys(DECLARED_WITHOUT_CONSUMER)
      .filter((kind) => new RegExp(`kind:\\s*'${kind}'`).test(producers))
      .sort();

    expect(
      leaked,
      'These RuleStatic kinds are documented as having no consumer, but the parser emits them ' +
        'anyway. A card carrying one reports modeled while the rule does nothing. Either ' +
        'implement the consumer and remove the entry, or remove the parser rule.',
    ).toEqual([]);
  });
});
