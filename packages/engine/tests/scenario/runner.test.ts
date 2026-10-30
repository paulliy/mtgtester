import { describe, expect, it } from 'vitest';
import { parseCardScenarioFile, type CardScenario } from '../../src/testing/card-scenario';
import {
  choiceAfterScript,
  firstDecisionOf,
  loadScenarioFile,
  runScenario,
  scenarioFailures,
} from './runner';

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

  it('plays the turn on through combat only when the scenario continues through it', () => {
    const attack = variant({
      seats: { P1: { battlefield: ['Scenario Bear'] } },
      script: [{ player: 'P1', choose: 'Declare attackers', targets: ['P2'] }],
      expect: [{ life: { player: 'P2', equals: 38 } }],
    });
    expect(() => runScenario(file, attack)).toThrow(/unused step/);
    const through = variant({ ...attack, continue: { throughCombat: true } });
    expect(scenarioFailures(runScenario(file, through), through)).toEqual([]);
    expect(() =>
      parseCardScenarioFile({
        ...file,
        scenarios: [{ ...base, continue: { throughCombat: false } }],
      }),
    ).toThrow(/continue\.throughCombat: must be true when present/);
  });

  it('stops at the first choice after the script instead of failing on it', () => {
    const choice = choiceAfterScript(file, variant({ script: [base.script[0]!] }));
    expect(choice?.decidingPlayer).toBe('P2');
    expect(choice?.legalActions.map((action) => action.description)).toContainEqual(
      expect.stringMatching(/Find Forest/),
    );
    expect(choiceAfterScript(file, base)).toBeNull();
  });

  it("returns a seat's first decision, or null when it is never asked", () => {
    const first = firstDecisionOf(file, base, 'P1');
    expect([first?.turn, first?.decidingPlayer]).toEqual([4, 'P1']);
    expect(first?.legalActions.map((action) => action.description)).toContainEqual(
      expect.stringMatching(/^Cast Path to Exile/),
    );
    expect(firstDecisionOf(file, base, 'P3')).toBeNull();
  });

  it("reads keywords from the controller's view, after layers", () => {
    const ettercap = loadScenarioFile(new URL('../scenarios/ettercap.json', import.meta.url));
    const scenario = ettercap.scenarios[0]!;
    const run = runScenario(ettercap, scenario);
    const card = 'Ettercap // Web Shot';
    expect(
      scenarioFailures(run, {
        ...scenario,
        expect: [{ keywords: { card, player: 'P1', has: ['reach', 'flying'], lacks: ['reach'] } }],
      }),
    ).toEqual([`${card} lacks flying`, `${card} has reach`]);
  });
});
