import { describe, expect, it } from 'vitest';
import { parseCardScenarioFile, type CardScenario } from '../../src/testing/card-scenario';
import { loadScenarioFile, runScenario, scenarioFailures } from './runner';

const file = loadScenarioFile(new URL('../scenarios/path-to-exile.json', import.meta.url));
const base = file.scenarios[0]!;
const variant = (change: Partial<CardScenario>): CardScenario => ({ ...base, ...change });

describe('the scenario runner', () => {
  it('refuses an unknown field anywhere in a scenario file', () => {
    const json = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    (json['scenarios'] as Array<Record<string, unknown>>)[0]!['goaded'] = 'P2';
    expect(() => parseCardScenarioFile(json, 'x.json')).toThrow(
      /x\.json\.scenarios\[0\]: unknown field "goaded"/,
    );
    const nested = JSON.parse(JSON.stringify(file)) as {
      scenarios: Array<{ seats: { P2: { battlefield: unknown[] } } }>;
    };
    nested.scenarios[0]!.seats.P2.battlefield = [{ card: 'Scenario Bear', sick: true }];
    expect(() => parseCardScenarioFile(nested, 'x.json')).toThrow(
      /battlefield\[0\]: unknown field "sick"/,
    );
  });

  it('throws on a card neither pinned nor supplied', () => {
    expect(() =>
      runScenario(file, variant({ seats: { P1: { hand: ['Path to Exile', 'Lab Unicorn'] } } })),
    ).toThrow(/"Lab Unicorn" is neither pinned nor a basic land/);
  });

  it('fails on a decision the script does not answer, printing it', () => {
    expect(() => runScenario(file, variant({ script: [base.script[0]!] }))).toThrow(
      /does not answer:\nP2 on turn 4.*\n.*Find Forest/s,
    );
  });

  it('fails on a step never used', () => {
    expect(() =>
      runScenario(
        file,
        variant({
          script: [...base.script, { player: 'P3', choose: 'Cast Lightning Bolt' }],
          end: 'gameOver',
          turnCap: 5,
        }),
      ),
    ).toThrow(/unused step/);
  });

  it('reports each expectation that does not hold', () => {
    const run = runScenario(file, base);
    expect(
      scenarioFailures(
        run,
        variant({
          expect: [
            { life: { player: 'P2', equals: 39 } },
            { zone: { player: 'P2', zone: 'battlefield', has: ['Scenario Bear'] } },
            { tapped: { card: 'Plains', player: 'P2', equals: false } },
            { event: { type: 'damage', count: 1 } },
          ],
        }),
      ),
    ).toEqual([
      'P2 life is 40, expected 39',
      expect.stringContaining("P2's battlefield lacks Scenario Bear"),
      'Plains is tapped',
      'expected 1 damage event(s), found 0',
    ]);
  });
});
