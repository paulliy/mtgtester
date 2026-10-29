/** ADR 0033 decision 7: no Forge script line in a tracked file outside docs. Part of the card gate. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forgeScriptLines, forgeTextErrors } from '../../../../scripts/contracts/forge-text';

// Built from pieces so this file never holds a whole script line itself.
const line = (head: string, kind: string, rest: string) => `${head}:${kind}$ ${rest}`;

describe('Forge script text', () => {
  it('finds script lines of each shape, and not prose about them', () => {
    const text = [
      line('A', 'SP', 'DealDamage | ValidTgts$ Creature | NumDmg$ 4'),
      line('T', 'Mode', 'ChangesZone | Origin$ Any | Destination$ Battlefield'),
      line('SVar:TrigDraw', 'DB', 'Draw | NumCards$ 1'),
      '  ' + line('R', 'Event', 'Moved | ValidCard$ Card.Self'),
      'A spell ability (SP$) deals damage | not a script line',
      line('A', 'SP', 'DealDamage with no parameters'),
      'Name:Mizzium Mortars',
    ].join('\n');
    expect(forgeScriptLines(text)).toEqual([1, 2, 3, 4]);
  });

  it('finds none in the tracked files outside docs', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter((file) => file !== '');
    expect(forgeTextErrors(files, (path) => readFileSync(path, 'utf8'))).toEqual([]);
  });
});
