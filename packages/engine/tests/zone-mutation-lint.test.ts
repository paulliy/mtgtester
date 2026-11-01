/** ADR 0034 decision 7: zone changes go through state/objects.ts, or say why not. */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// A cold ESLint start (config load, type info) can exceed the 5s default when files run in parallel.
const ESLINT_CHILD_TIMEOUT_MS = 60_000;

const eslint = new ESLint();
async function violations(code: string, file = 'packages/engine/src/effects/probe.ts') {
  const results = await eslint.lintText(code, { filePath: file });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'zone-mutation/outside-objects')
    .map((message) => message.line);
}

describe('zone mutations outside state/objects.ts', () => {
  it(
    'rejects adding to a zone a card enters, and reassigning any zone',
    async () => {
      expect(
        await violations(
          [
            'ctx.state.battlefield.push(perm);',
            'ctx.state.exile.unshift(card);',
            'player.graveyard.splice(0, 0, card);',
            'player.hand = [];',
            'player.library = rest;',
          ].join('\n'),
        ),
      ).toEqual([1, 2, 3, 4, 5]);
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );

  it(
    'allows reordering a library in place, and reading zones',
    async () => {
      expect(
        await violations(
          'player.library.unshift(card);\nplayer.library.splice(0, 1);\nconst n = player.hand.length;',
        ),
      ).toEqual([]);
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );

  it(
    'accepts a reason on the line or above, covering a run of lines, and not an empty one',
    async () => {
      expect(
        await violations(
          [
            '// zone-mutation: the departed player leaves the game (CR 800.4a)',
            'player.hand = [];',
            'player.graveyard = [];',
            '',
            'player.commandZone = [];',
            'ctx.state.exile.push(card); // zone-mutation: a new card copy',
            '// zone-mutation:',
            'ctx.state.exile.push(card);',
          ].join('\n'),
        ),
      ).toEqual([5, 8]);
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );

  it(
    'leaves state/objects.ts and test setup to do it',
    async () => {
      const code = 'ctx.state.battlefield.push(perm);';
      expect(await violations(code, 'packages/engine/src/state/objects.ts')).toEqual([]);
      expect(await violations(code, 'packages/engine/src/testing/prepared-scenario.ts')).toEqual(
        [],
      );
    },
    ESLINT_CHILD_TIMEOUT_MS,
  );
});
