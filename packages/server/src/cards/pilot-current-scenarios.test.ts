import { describe, expect, it } from 'vitest';
import type { DecisionRequest, GameId, LegalAction } from '@mtg/shared';
import type { GameContext } from '../../../engine/src/state/types';
import { PILOT_CURRENT_ALL_SCENARIO_IDS } from './pilot-current-scenario-catalog';
import { pilotCurrentScenario } from './pilot-current-scenarios';

/** One P1 priority action: cast or play a hand card, or activate an ability, naming targets. */
interface Step {
  cast?: string;
  play?: string;
  activate?: string;
  /** Per target slot: a seat id or a permanent name. */
  targets?: string[];
  /** Take the step only with an empty stack. */
  whenEmpty?: true;
}

/** What the viewer does, as engine actions. */
interface Plan {
  steps: Step[];
  /** Options P1 picks in non-priority decisions, matched against the description, in order. */
  answers?: RegExp[];
  /** The seat each named creature attacks; the rest stay home. */
  attacks?: Record<string, string>;
}

const PLANS: Record<string, Plan> = {
  'pilot-current-jet-medallion-viewer-reduced': { steps: [{ cast: 'Pilot Lab Black Sorcery' }] },
  'pilot-current-jet-medallion-viewer-not-red': { steps: [] },
  'pilot-current-great-henge-viewer-cast-reduced': { steps: [{ cast: 'The Great Henge' }] },
  'pilot-current-great-henge-viewer-enter-trigger': { steps: [{ cast: 'Pilot Lab Bear' }] },
  'pilot-current-great-henge-viewer-token-ignored': { steps: [{ cast: 'Pilot Lab Saproling' }] },
  'pilot-current-great-henge-viewer-opponent-creature': { steps: [] },
  'pilot-current-explore-viewer-second-land': {
    steps: [{ play: 'Forest' }, { cast: 'Explore' }, { play: 'Plains', whenEmpty: true }],
  },
};

/** Play a scenario to the end with P1 following its plan and the other seats as the lab runs them. */
function run(id: string) {
  const scenario = pilotCurrentScenario(id, `pilot-current-test-${id}` as GameId);
  const plan = PLANS[id]!;
  const ctx = (scenario.engine as unknown as { ctx: GameContext }).ctx;
  const steps = [...plan.steps];
  const answers = [...(plan.answers ?? [])];
  const done: string[] = [];
  const picked: string[] = [];
  const offered: string[][] = [];
  /** The prompts of the choices put to P1 other than priority and combat declarations. */
  const asked: string[] = [];
  const nameOf = (objectId: string) =>
    ctx.state.battlefield.find((perm) => perm.id === objectId)?.name ?? objectId;
  for (let decisions = 0; ; decisions++) {
    if (decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request: DecisionRequest = step.request;
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      const pass = request.legalActions.find((action) => action.type === 'pass');
      scenario.engine.submit(
        provider?.decide(request) ?? {
          requestId: request.requestId,
          actionId: (pass ?? request.legalActions[0]!).id,
        },
      );
      continue;
    }
    offered.push(request.legalActions.map((action) => action.description));
    let action: LegalAction | undefined;
    let targets: Array<{ slot: number; choice: string }> | undefined;
    const attack = request.legalActions.find((option) => option.type === 'attackDeclaration');
    if (attack !== undefined) {
      const subjects = (attack.data?.['subjects'] ?? []) as Array<{ subjectId: string }>;
      action = attack;
      targets = (attack.targets ?? []).map((slot) => {
        const defender = plan.attacks?.[nameOf(subjects[slot.slot]!.subjectId)];
        return {
          slot: slot.slot,
          choice:
            defender !== undefined && slot.options.includes(defender) ? defender : '__no_attack__',
        };
      });
    }
    const isPriority = request.legalActions.some((option) => option.type === 'pass');
    if (!isPriority && action === undefined) asked.push(request.prompt);
    const next = steps[0];
    if (
      action === undefined &&
      isPriority &&
      next !== undefined &&
      (next.whenEmpty !== true || ctx.state.stack.length === 0)
    ) {
      action = request.legalActions.find((option) =>
        next.play !== undefined
          ? option.type === 'playLand' && option.description === `Play ${next.play}`
          : next.cast !== undefined
            ? option.type === 'castSpell' && option.description.startsWith(`Cast ${next.cast}`)
            : option.type === 'activateAbility' && option.description.includes(next.activate!),
      );
      if (action !== undefined) {
        steps.shift();
        done.push(next.play ?? next.cast ?? next.activate!);
        targets = (action.targets ?? []).map((slot) => {
          const want = next.targets?.[slot.slot];
          const choice = slot.options.find((option) => option === want || nameOf(option) === want);
          if (choice === undefined) throw new Error(`${id}: no target ${want} for ${slot.slot}`);
          return { slot: slot.slot, choice };
        });
      }
    }
    if (action === undefined && !isPriority)
      for (const pattern of answers) {
        const found = request.legalActions.find((option) => pattern.test(option.description));
        if (found !== undefined) {
          action = found;
          picked.push(found.description);
          answers.splice(answers.indexOf(pattern), 1);
          break;
        }
      }
    action ??= request.legalActions.find((option) => option.type === 'pass');
    action ??= request.legalActions[0]!;
    scenario.engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets === undefined ? {} : { targets }),
    });
  }
  const state = ctx.state;
  const player = (seat: string) => state.players.find((candidate) => candidate.id === seat)!;
  const permanent = (name: string) => state.battlefield.find((perm) => perm.name === name);
  return { ctx, state, done, picked, offered, asked, steps, player, permanent };
}

type Result = ReturnType<typeof run>;
const zoneNames = (cards: ReadonlyArray<{ name: string }>) => cards.map((item) => item.name);

const CHECKS: Record<string, (result: Result) => void> = {
  'pilot-current-jet-medallion-viewer-reduced': (r) => {
    expect(r.done).toEqual(['Pilot Lab Black Sorcery']);
    expect(r.player('P1').life).toBe(42);
    expect(zoneNames(r.player('P1').graveyard)).toContain('Pilot Lab Black Sorcery');
    expect(r.permanent('Swamp')!.tapped).toBe(true);
  },
  'pilot-current-jet-medallion-viewer-not-red': (r) => {
    expect(r.offered.length).toBeGreaterThan(0);
    for (const actions of r.offered)
      expect(actions.some((action) => action.startsWith('Cast Pilot Lab Red Sorcery'))).toBe(false);
    expect(zoneNames(r.player('P1').hand)).toContain('Pilot Lab Red Sorcery');
    expect(r.player('P1').life).toBe(40);
  },
  'pilot-current-explore-viewer-second-land': (r) => {
    expect(r.done).toEqual(['Forest', 'Explore', 'Plains']);
    expect(
      r.state.battlefield
        .filter((perm) => perm.controllerId === 'P1')
        .map((perm) => perm.name)
        .sort(),
    ).toEqual(['Forest', 'Forest', 'Forest', 'Plains']);
    expect(r.player('P1').landsPlayedThisTurn).toBe(2);
    // Explore drew a card; Island was never offered as a third land play.
    const hand = zoneNames(r.player('P1').hand);
    expect(hand).toContain('Island');
    expect(hand).toHaveLength(3);
    expect(r.offered.at(-1)!.some((action) => action.startsWith('Play '))).toBe(false);
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['Explore']);
  },
  'pilot-current-great-henge-viewer-cast-reduced': (r) => {
    expect(r.done).toEqual(['The Great Henge']);
    expect(r.permanent('The Great Henge')).toBeDefined();
    const forests = r.state.battlefield.filter((perm) => perm.name === 'Forest');
    expect(forests.map((perm) => perm.tapped)).toEqual([true, true, true, true, true]);
    // Henge is not a creature: its own entry does not trigger it.
    expect(r.player('P1').hand).toHaveLength(1);
    expect(r.permanent('The Great Henge')!.counters['+1/+1']).toBeUndefined();
  },
  'pilot-current-great-henge-viewer-enter-trigger': (r) => {
    expect(r.done).toEqual(['Pilot Lab Bear']);
    expect(r.player('P1').life).toBe(42);
    expect(r.permanent('The Great Henge')!.tapped).toBe(true);
    expect(r.permanent('Pilot Lab Bear')!.counters['+1/+1']).toBe(1);
    // The Trinket and the drawn card; the trigger asked nothing.
    expect(r.player('P1').hand).toHaveLength(2);
    expect(r.asked).toEqual([]);
  },
  'pilot-current-great-henge-viewer-opponent-creature': (r) => {
    expect(r.state.battlefield.find((perm) => perm.name === 'Pilot Lab Bear')?.controllerId).toBe(
      'P2',
    );
    expect(r.permanent('Pilot Lab Bear')!.counters['+1/+1']).toBeUndefined();
    expect(r.player('P1').hand).toHaveLength(1);
  },
  'pilot-current-great-henge-viewer-token-ignored': (r) => {
    expect(r.done).toEqual(['Pilot Lab Saproling']);
    const token = r.permanent('Saproling');
    expect(token).toBeDefined();
    expect(token!.counters['+1/+1']).toBeUndefined();
    expect(r.player('P1').hand).toHaveLength(1);
  },
};

describe('pilot-current Card Test Lab scenarios', () => {
  it('has a plan and a check for every declared scenario', () => {
    expect(Object.keys(PLANS).sort()).toEqual([...PILOT_CURRENT_ALL_SCENARIO_IDS].sort());
    expect(Object.keys(CHECKS).sort()).toEqual([...PILOT_CURRENT_ALL_SCENARIO_IDS].sort());
  });

  for (const id of PILOT_CURRENT_ALL_SCENARIO_IDS)
    it(id, () => {
      const result = run(id);
      expect(result.steps).toEqual([]);
      CHECKS[id]!(result);
    });
});
