/**
 * PR08.17: Reins of Power Card Test Lab replay.
 *
 * Both scenarios run the printed {2}{U}{U} instant through the production engine — real legality,
 * real payment, the real stack, real priority passes, real resolution — and then assert the
 * AUTHORITATIVE state and event stream, not the scenario's own arrangement:
 *
 *  - the paid lands are the four Islands, one `tapForMana` event each, and the spell resolves from
 *    P1's hand into P1's graveyard;
 *  - the untap, the control grants, and the haste grants name the EXACT objects, each set frozen
 *    before the next sentence's control change;
 *  - both groups are swapped for the whole rest of the turn, so the swap is still in force in the
 *    end step and only ends at the cleanup step (CR 514.2);
 *  - reverting control and ending haste leave the creatures UNTAPPED: the untap instruction is not
 *    undone, and nothing retaps them on the way out;
 *  - the third player's creature is in neither group: it never untapped, never changed controller,
 *    never gained haste.
 *
 * The two scenarios differ only in whether the caster owns a creature, because "all creatures you
 * control" may legitimately be the empty set (the second scenario's P1 has no creatures at all).
 */
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { strictCardTestScenario } from './card-test-scenarios';

type Mode = 'swap-and-cleanup' | 'empty-caster';

interface BoardEntry {
  name: string;
  controllerId: string;
  tapped: boolean;
}

interface Observation {
  phase: string;
  step: string | null;
  turn: number;
  entries: BoardEntry[];
  /** Battlefield-order names of every permanent whose current characteristics include haste. */
  haste: string[];
}

function replay(mode: Mode) {
  const scenario = strictCardTestScenario(`reins-of-power-viewer-${mode}`, 'pr08-reins-test');
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  const ctx = (engine as unknown as { ctx: GameContext }).ctx;
  const observations: Observation[] = [];
  let cast = false;
  let offeredTargets: string[] | undefined;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    const state = engine.getState();
    observations.push({
      phase: state.phase,
      step: state.step,
      turn: state.turnNumber,
      entries: state.battlefield.map((perm) => ({
        name: perm.name,
        controllerId: perm.controllerId,
        tapped: perm.tapped,
      })),
      haste: state.battlefield
        .filter((perm) =>
          computeCharacteristics(ctx, perm as unknown as EnginePermanent).keywords.includes(
            'haste',
          ),
        )
        .map((perm) => perm.name),
    });
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 100) throw new Error(`Reins of Power ${mode} failed to finish`);
    const request = step.request;
    const castAction = request.legalActions.find(
      (action) =>
        action.type === 'castSpell' && action.description.startsWith('Cast Reins of Power'),
    );
    // Pass on a stable rule so the replay is reproducible rather than order-dependent.
    let action =
      request.legalActions.find((candidate) => candidate.type === 'pass') ??
      request.legalActions[0]!;
    let targets: Array<{ slot: number; choice: string }> | undefined;
    if (!cast && castAction !== undefined) {
      action = castAction;
      cast = true;
      const slot = castAction.targets![0]!;
      offeredTargets = [...slot.options];
      targets = [{ slot: slot.slot, choice: 'P2' }];
    }
    engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets === undefined ? {} : { targets }),
    });
  }
  return {
    state: engine.getState(),
    observations,
    cast,
    offeredTargets,
    haltReason: engine.getResult()?.haltReason ?? null,
  };
}

const last = (run: ReturnType<typeof replay>): Observation => run.observations.at(-1)!;
const perm = (observation: Observation, name: string): BoardEntry | undefined =>
  observation.entries.find((entry) => entry.name === name);

/** Observations where the named creatures actually carry haste. */
const withHaste = (run: ReturnType<typeof replay>, ...names: string[]): Observation[] =>
  run.observations.filter((observation) => names.every((name) => observation.haste.includes(name)));

describe('Reins of Power Card Test Lab replay', () => {
  it('reins-of-power-viewer-swap-and-cleanup — both groups swap until cleanup, then revert untapped', () => {
    const first = replay('swap-and-cleanup');
    const second = replay('swap-and-cleanup');
    expect(first.state.eventLog).toEqual(second.state.eventLog);
    expect(first.haltReason).toBeNull();
    expect(first.cast).toBe(true);
    expect(first.state.stack).toEqual([]);

    // "target opponent": the only legal targets are the three opponents, never the caster.
    expect(first.offeredTargets).toEqual(['P2', 'P3', 'P4']);

    // The normal {2}{U}{U} path: four Islands tapped for mana, the spell cast from P1's hand and
    // resolved back into P1's graveyard.
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'tapForMana')
        .map((event) => event.payload['name']),
    ).toEqual(['Island', 'Island', 'Island', 'Island']);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'castSpell')
        .map((event) => event.payload),
    ).toMatchObject([{ player: 'P1', name: 'Reins of Power', targets: ['P2'] }]);
    expect(
      first.state.eventLog.find(
        (event) => event.type === 'zoneChange' && event.payload['name'] === 'Reins of Power',
      )?.payload,
    ).toMatchObject({ from: 'stack', to: 'graveyard', owner: 'P1' });
    const islands = first.state.battlefield.filter((p) => p.name === 'Island');
    expect(islands).toHaveLength(4);
    expect(islands.every((island) => island.controllerId === 'P1' && island.tapped)).toBe(true);

    // Both sentences applied to the exact frozen objects, in battlefield order: the caster's own
    // creature first, then the target opponent's.
    expect(
      first.state.eventLog.find(
        (event) => event.type === 'untap' && event.payload['source'] === 'Reins of Power',
      )?.payload['objects'],
    ).toMatchObject([{ name: 'Lab Trader' }, { name: 'Lab Ox' }]);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'gainControl')
        .map((event) => event.payload),
    ).toMatchObject([
      { source: 'Reins of Power', target: 'Lab Trader', newController: 'P2' },
      { source: 'Reins of Power', target: 'Lab Ox', newController: 'P1' },
    ]);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'grantKeyword')
        .map((event) => event.payload),
    ).toMatchObject([
      { source: 'Reins of Power', target: 'Lab Trader', keyword: 'haste' },
      { source: 'Reins of Power', target: 'Lab Ox', keyword: 'haste' },
    ]);

    // "until end of turn": the swap and the haste both survive the end step and end only at the
    // cleanup step, where control returns and the haste expires together.
    const endStep = withHaste(first, 'Lab Trader', 'Lab Ox').find(
      (observation) => observation.phase === 'ending' && observation.step === 'end',
    );
    expect(endStep).toBeDefined();
    expect(perm(endStep!, 'Lab Trader')).toMatchObject({ controllerId: 'P2', tapped: false });
    expect(perm(endStep!, 'Lab Ox')).toMatchObject({ controllerId: 'P1', tapped: false });

    // Cleanup reverted control and dropped the haste, and did NOT undo the untap.
    const final = last(first);
    expect(perm(final, 'Lab Trader')).toMatchObject({ controllerId: 'P1', tapped: false });
    expect(perm(final, 'Lab Ox')).toMatchObject({ controllerId: 'P2', tapped: false });
    expect(final.haste).toEqual([]);

    // The third player was never in either group: untouched, still tapped, still their creature.
    expect(perm(first.observations[0]!, 'Lab Uninvolved Servo')).toMatchObject({
      controllerId: 'P3',
      tapped: true,
    });
    expect(perm(final, 'Lab Uninvolved Servo')).toMatchObject({
      controllerId: 'P3',
      tapped: true,
    });
    for (const observation of first.observations) {
      expect(observation.haste).not.toContain('Lab Uninvolved Servo');
      expect(perm(observation, 'Lab Uninvolved Servo')?.controllerId).toBe('P3');
      expect(perm(observation, 'Lab Uninvolved Servo')?.tapped).toBe(true);
    }
  });

  it('reins-of-power-viewer-empty-caster — an empty caster group is valid and the opponent’s group still swaps', () => {
    const first = replay('empty-caster');
    const second = replay('empty-caster');
    expect(first.state.eventLog).toEqual(second.state.eventLog);
    expect(first.haltReason).toBeNull();
    expect(first.cast).toBe(true);
    expect(first.offeredTargets).toEqual(['P2', 'P3', 'P4']);

    // The caster really does start with no creatures of their own.
    const opening = first.observations[0]!;
    expect(
      opening.entries.filter((entry) => entry.controllerId === 'P1' && entry.name !== 'Island'),
    ).toEqual([]);
    expect(opening.haste).toEqual([]);

    expect(
      first.state.eventLog
        .filter((event) => event.type === 'tapForMana')
        .map((event) => event.payload['name']),
    ).toEqual(['Island', 'Island', 'Island', 'Island']);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'castSpell')
        .map((event) => event.payload),
    ).toMatchObject([{ player: 'P1', name: 'Reins of Power', targets: ['P2'] }]);

    // Only the opponent's group exists, and every recorded object is the Lab Ox.
    expect(
      first.state.eventLog.find(
        (event) => event.type === 'untap' && event.payload['source'] === 'Reins of Power',
      )?.payload['objects'],
    ).toMatchObject([{ name: 'Lab Ox' }]);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'gainControl')
        .map((event) => event.payload),
    ).toMatchObject([{ source: 'Reins of Power', target: 'Lab Ox', newController: 'P1' }]);
    expect(
      first.state.eventLog
        .filter((event) => event.type === 'grantKeyword')
        .map((event) => event.payload),
    ).toMatchObject([{ source: 'Reins of Power', target: 'Lab Ox', keyword: 'haste' }]);

    // The single swapped creature is now P1's, untapped and hasty.
    const swapped = withHaste(first, 'Lab Ox').at(-1)!;
    expect(perm(swapped, 'Lab Ox')).toMatchObject({ controllerId: 'P1', tapped: false });
    expect(perm(swapped, 'Lab Trader')).toBeUndefined();

    const final = last(first);
    expect(perm(final, 'Lab Ox')).toMatchObject({ controllerId: 'P1', tapped: false });
    expect(final.haste).toEqual(['Lab Ox']);
    expect(perm(final, 'Lab Uninvolved Servo')).toMatchObject({
      controllerId: 'P3',
      tapped: true,
    });
  });
});
