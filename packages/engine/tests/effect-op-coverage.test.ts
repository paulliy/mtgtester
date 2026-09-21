import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `Effect` op declared in the IR must have an executor arm somewhere.
 *
 * `executeAbility`'s switch is not exhaustively typed (it falls through a `default`), so an op
 * added to the union — or produced by a parser rule written before its executor — compiles,
 * typechecks, and then does NOTHING at resolution. That is the worst failure mode this project
 * has: the card reports `modeled: true`, the AI is offered the action, and the game state
 * silently does not change.
 *
 * Five ops were in exactly that state when this guard was written (`returnToHandEach`,
 * `exileEach`, `removeCountersEach`, `graveyardToBattlefieldEach`, `graveyardToHandEach`,
 * `grantHasteOnResolution`, `copyEachTargetedSpell`) — two of them reachable from shipped
 * overrides on committed fixture decks.
 */
const ENGINE_SRC = join(import.meta.dirname, '..', 'src');

const EXECUTOR_FILES = [
  'effects/resolve.ts',
  'effects/continuous.ts',
  'stack/stack.ts',
  'turn/turn.ts',
  'combat/combat.ts',
  'actions/apply.ts',
  'sba/sba.ts',
];

describe('effect IR op coverage', () => {
  it('has an executor arm for every op the ability IR declares', () => {
    const ability = readFileSync(join(ENGINE_SRC, 'cards', 'ability.ts'), 'utf8');
    const declared = new Set(
      [...ability.matchAll(/\{\s*op:\s*'([A-Za-z0-9_]+)'/g)].map((match) => match[1] as string),
    );
    expect(declared.size).toBeGreaterThan(150);

    const executors = EXECUTOR_FILES.map((file) =>
      readFileSync(join(ENGINE_SRC, file), 'utf8'),
    ).join('\n');
    const handled = new Set(
      [...executors.matchAll(/case\s+'([A-Za-z0-9_]+)'/g)].map((match) => match[1] as string),
    );

    const unimplemented = [...declared].filter((op) => !handled.has(op)).sort();
    expect(
      unimplemented,
      'These IR ops are declared (and may be produced by the parser or an override) but have no ' +
        'executor arm, so they resolve as silent no-ops. Implement them, or delete the op and the ' +
        'parser rule that emits it.',
    ).toEqual([]);
  });
});
