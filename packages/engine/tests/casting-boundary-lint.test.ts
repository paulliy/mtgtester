import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// A cold ESLint start (config load, type info) can exceed the 5s default when files run in parallel.
const ESLINT_CHILD_TIMEOUT_MS = 60_000;

const eslint = new ESLint();
async function violations(file: string, code: string) {
  const results = await eslint.lintText(code, { filePath: `packages/engine/src/${file}` });
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'casting-boundary/constructors');
}

describe('casting constructor and export boundary', () => {
  it.each([
    "const spell = {kind: 'spell', card: obj, sourceOracleId: id};",
    "const spell = {kind: 'spell' as const, sourceCardId: id};",
    'const spell: EngineStackObject = {...other};',
    'const spell: EngineStackObject = {...other, kind: dynamicKind};',
    'const spell = {...other} satisfies EngineStackObject;',
    'const spell = {...other} as EngineStackObject;',
    'function secondCast(): EngineStackObject { return {...original}; }',
    'const secondCast = (): EngineStackObject => ({...original});',
    'const secondCast = function(): EngineStackObject { return {...original}; };',
    'const secondCast: () => EngineStackObject = () => ({...original});',
    'const secondCast: () => EngineStackObject = () => { return {...original}; };',
    "import type * as Types from './state/types'; const spell: Types.EngineStackObject = {...other};",
    "import type {EngineStackObject as Stack} from './state/types'; function secondCast(): Stack { return {...original}; }",
    "import {castSpell as secondCast} from '../casting/cast';",
    "export {castSpell} from './casting/cast';",
    "export * from './casting/preview.js';",
    "export * from './stack/copy';",
    "import {queueSpellCopy} from '../stack/copy';",
  ])('rejects a duplicate or exported constructor: %s', async (code) => {
    expect(await violations('index.ts', code)).not.toEqual([]);
  });

  it('does not let the scenario route import a casting preview constructor', async () => {
    expect(
      await violations(
        'testing/prepared-scenario.ts',
        "import {castingPreviewContext} from '../casting/preview';",
      ),
    ).not.toEqual([]);
  });

  it('does not let an action barrel export castSpell alongside trigger helpers', async () => {
    expect(
      await violations(
        'actions/apply.ts',
        "export {queueWardTriggers, castSpell} from '../casting/cast';",
      ),
    ).not.toEqual([]);
  });

  it.each([
    ['actions/apply.ts', "import {castSpell as cast} from '../casting/cast'; export {cast};"],
    ['actions/apply.ts', "export {cast}; import {castSpell as cast} from '../casting/cast';"],
    [
      'actions/legal.ts',
      "import {castingPreviewContext as preview} from '../casting/preview'; export default preview;",
    ],
    ['effects/resolve.ts', "import * as copies from '../stack/copy'; export {copies};"],
    ['actions/apply.ts', "const casting = await import('../casting/cast.js');"],
    [
      'actions/apply.ts',
      "import {castSpell as cast} from '../casting/cast'; const escaped = cast; export {escaped};",
    ],
    [
      'actions/apply.ts',
      "export {escaped}; const escaped = cast; import {castSpell as cast} from '../casting/cast';",
    ],
    [
      'actions/apply.ts',
      "import {castSpell as cast} from '../casting/cast'; export const escaped = cast;",
    ],
    [
      'index.ts',
      "import type {EngineStackObject as Stack} from './state/types'; const copy: Stack = {...original};",
    ],
    [
      'index.ts',
      'type Stack = EngineStackObject; type Copy = Stack; const copy = {...original} satisfies Copy;',
    ],
  ])('rejects a binding escape in %s: %s', async (file, code) => {
    expect(await violations(file, code)).not.toEqual([]);
  });

  it.each([
    [
      'actions/apply.ts',
      "import {queueWardTriggers as ward} from '../casting/cast'; export {ward};",
    ],
    [
      'sba/sba.ts',
      "import type {EngineStackObject as Stack} from '../state/types'; const ability: Stack = {kind: 'triggeredAbility', card: null};",
    ],
    ['casting/cast.ts', "const spell: EngineStackObject = {kind: 'spell', card: obj};"],
    ['casting/preview.ts', "const spell: EngineStackObject = {kind: 'spell', card: obj};"],
    ['stack/copy.ts', 'const copy: EngineStackObject = {...original, card: null};'],
    ['actions/apply.ts', "import {castSpell} from '../casting/cast';"],
    ['actions/legal.ts', "import {castingPreviewContext} from '../casting/preview';"],
    ['effects/resolve.ts', "import {queueSpellCopy} from '../stack/copy';"],
    ['testing/prepared-scenario.ts', "import {preparedScenarioSpell} from '../casting/preview';"],
    [
      'actions/apply.ts',
      "export {queueWardTriggers, queueBecomesTargetedTriggers} from '../casting/cast';",
    ],
    [
      'actions/apply.ts',
      "const ability: EngineStackObject = {kind: 'activatedAbility', card: null};",
    ],
    ['sba/sba.ts', "const ability: EngineStackObject = {kind: 'triggeredAbility', card: null};"],
    ['cards/templates.ts', "const ability = {kind: 'spell', targets: [], effects: []};"],
    [
      'sba/sba.ts',
      "function triggered(): EngineStackObject { return {kind: 'triggeredAbility', card: null}; }",
    ],
    [
      'sba/sba.ts',
      "const activated = (): EngineStackObject => ({kind: 'activatedAbility', card: null});",
    ],
  ])('accepts the authorized %s route', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });
});

it(
  'resolves authorized file identities when ESLint runs from a nested directory',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const output = execFileSync(
      process.execPath,
      [
        resolve('node_modules/eslint/bin/eslint.js'),
        resolve('packages/engine/src/casting/cast.ts'),
        '--format',
        'json',
      ],
      { cwd: resolve('packages/engine'), encoding: 'utf8' },
    );
    const results = JSON.parse(output) as { messages: { ruleId: string }[] }[];
    expect(
      results
        .flatMap((result) => result.messages)
        .filter((message) => message.ruleId === 'casting-boundary/constructors'),
    ).toEqual([]);
  },
  ESLINT_CHILD_TIMEOUT_MS,
);
