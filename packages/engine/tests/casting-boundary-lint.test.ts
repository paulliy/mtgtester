import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

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
  ])('accepts the authorized %s route', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });
});
