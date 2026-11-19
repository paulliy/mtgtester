import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { CASTING_STATICS_ALL_SCENARIOS } from './casting-statics-scenario-catalog';
import {
  CASTING_STATICS_SCENARIOS,
  canonicalSha256,
  castingStaticsClauseIds,
  castingStaticsScenario,
} from './casting-statics-scenarios';

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/casting-statics-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cards: { sha256: string; card: OracleCard }[] };

/** One P1 priority action: cast a hand card or activate an ability, choosing targets by name. */
interface Step {
  cast?: string;
  activate?: string;
  /** Preferred choice per target slot: a seat id or a permanent name. */
  targets?: string[];
  /** Take the step only once the stack is empty. */
  whenEmpty?: boolean;
  /** Take the step only while something is on the stack. */
  whenStack?: boolean;
  /** The squad (or other optional-cost) count of the cast to choose. */
  optionalCount?: number;
  /** The modal cast whose mode label matches. */
  mode?: RegExp;
}

/** What P1 does in the viewer, expressed as engine actions. */
interface Plan {
  steps: Step[];
  /** Options P1 picks in non-priority decisions, matched against the description, in order. */
  answers?: RegExp[];
  /** Which defending seat each named creature attacks; the rest stay home. */
  attacks?: Record<string, string>;
}

const PLANS: Record<string, Plan> = {
  'casting-statics-vedalken-orrery-viewer-flash-response': {
    steps: [{ cast: 'CS Lab Bear', whenStack: true }],
  },
  'casting-statics-thalia-guardian-of-thraben-viewer-noncreature-tax': {
    steps: [{ cast: 'CS Lab Shock', targets: ['P2'] }],
  },
  'casting-statics-torbran-thane-of-red-fell-viewer-plus-two': {
    steps: [{ cast: 'CS Lab Shock', targets: ['P2'] }],
  },
  'casting-statics-fiery-emancipation-viewer-triple': {
    steps: [{ cast: 'CS Lab Shock', targets: ['P2'] }],
  },
  'casting-statics-knight-of-dawn-s-light-viewer-plus-first': {
    steps: [{ cast: 'CS Lab Salve' }],
    answers: [/^Knight of Dawn's Light: gain that much life plus 1/],
  },
  'casting-statics-rhox-faithmender-viewer-twice-first': {
    steps: [{ cast: 'CS Lab Salve' }],
    answers: [/^Rhox Faithmender: gain twice that much life/],
  },
  'casting-statics-boon-reflection-viewer-payment-order': {
    steps: [{ cast: 'CS Lab Mending' }],
  },
};

/** What a player was offered at one decision, with the target options named. */
interface Seen {
  player: string;
  stack: string[];
  battlefield: string[];
  actions: { type: string; description: string; targets: string[][] }[];
}

function run(id: string) {
  const scenario = castingStaticsScenario(id, `server-${id}` as never);
  const ctx = (scenario.engine as unknown as { ctx: GameContext }).ctx;
  const plan = PLANS[id]!;
  const steps = [...plan.steps];
  const answers = [...(plan.answers ?? [])];
  const seen: Seen[] = [];
  const picked: string[] = [];
  const done: string[] = [];
  const nameOf = (objectId: string) =>
    ctx.state.battlefield.find((perm) => perm.id === objectId)?.name ??
    ctx.state.stack.find((item) => item.id === objectId)?.description ??
    objectId;
  const idFor = (want: string | undefined, options: readonly string[]) => {
    if (want === undefined) return options[0]!;
    if (options.includes(want)) return want;
    const byName = options.find((option) => nameOf(option) === want);
    return byName ?? options[0]!;
  };
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    seen.push({
      player: request.decidingPlayer,
      stack: ctx.state.stack.map((item) => item.description),
      battlefield: ctx.state.battlefield.map((perm) => perm.name),
      actions: request.legalActions.map((action) => ({
        type: action.type,
        description: action.description,
        targets: (action.targets ?? []).map((slot) => slot.options.map(nameOf)),
      })),
    });
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      if (provider !== undefined) {
        scenario.engine.submit(provider.decide(request));
        continue;
      }
      const pass = request.legalActions.find((action) => action.type === 'pass');
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: (pass ?? request.legalActions[0]!).id,
      });
      continue;
    }
    let action: LegalAction | undefined;
    let targets: { slot: number; choice: string }[] | undefined;
    const attack = request.legalActions.find((option) => option.type === 'attackDeclaration');
    if (attack !== undefined) {
      const subjects = (attack.data?.['subjects'] ?? []) as { subjectId: string }[];
      action = attack;
      targets = (attack.targets ?? []).map((slot) => {
        const attacker = nameOf(subjects[slot.slot]!.subjectId);
        const defender = plan.attacks?.[attacker];
        return {
          slot: slot.slot,
          choice:
            defender !== undefined && slot.options.includes(defender) ? defender : '__no_attack__',
        };
      });
    }
    const next = steps[0];
    const isPriority = request.legalActions.some((option) => option.type === 'pass');
    if (
      action === undefined &&
      isPriority &&
      next !== undefined &&
      (next.whenEmpty !== true || ctx.state.stack.length === 0) &&
      (next.whenStack !== true || ctx.state.stack.length > 0)
    ) {
      action = request.legalActions.find((option) =>
        next.cast !== undefined
          ? option.type === 'castSpell' &&
            option.description.startsWith(`Cast ${next.cast}`) &&
            (next.optionalCount === undefined ||
              option.data?.['optionalCostCount'] === next.optionalCount) &&
            (next.mode === undefined ||
              next.mode.test(`${option.description} ${String(option.data?.['modeLabel'] ?? '')}`))
          : option.type === 'activateAbility' && option.description.startsWith(next.activate!),
      );
      if (action !== undefined) {
        steps.shift();
        done.push(next.cast ?? next.activate!);
        targets = (action.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: idFor(next.targets?.[slot.slot], slot.options),
        }));
      }
    }
    if (action === undefined && !isPriority) {
      const pickable = request.legalActions;
      for (const pattern of answers) {
        const found = pickable.find((candidate) => pattern.test(candidate.description));
        if (found !== undefined) {
          action = found;
          picked.push(found.description);
          answers.splice(answers.indexOf(pattern), 1);
          break;
        }
      }
      // A batched target prompt: each slot takes the first option an answer names.
      const prompt = request.legalActions.find((candidate) => candidate.type === 'chooseTargets');
      if (action === undefined && prompt !== undefined) {
        action = prompt;
        targets = (prompt.targets ?? []).map((slot) => {
          const option = slot.options.find((choice) =>
            answers.some((pattern) => pattern.test(nameOf(choice))),
          );
          if (option !== undefined) picked.push(nameOf(option));
          return { slot: slot.slot, choice: option ?? slot.options[0]! };
        });
      }
    }
    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0]!;
    scenario.engine.submit({
      requestId: request.requestId,
      actionId: action.id,
      ...(targets !== undefined ? { targets } : {}),
    });
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }
  const state = ctx.state;
  const player = (seat: string) => state.players.find((candidate) => candidate.id === seat)!;
  const permanent = (name: string): EnginePermanent | undefined =>
    state.battlefield.find((perm) => perm.name === name);
  return { scenario, ctx, state, seen, picked, done, player, permanent };
}
type Result = ReturnType<typeof run>;

const zoneNames = (cards: readonly { name: string }[]) => cards.map((item) => item.name);
const named = (result: Result, name: string) =>
  result.state.battlefield.filter((perm) => perm.name === name);

const CHECKS: Record<string, (result: Result) => void> = {
  'casting-statics-vedalken-orrery-viewer-flash-response': (r) => {
    // The Bear was cast while P2's Shock was on the stack, and resolved first.
    const orrery = r.seen.find(
      (seen) =>
        seen.player === 'P1' &&
        seen.stack.some((item) => item.includes('CS Lab Shock')) &&
        seen.actions.some((action) => action.description.startsWith('Cast CS Lab Bear')),
    );
    expect(orrery).toBeDefined();
    expect(r.permanent('CS Lab Bear')).toBeDefined();
    expect(r.player('P1').life).toBe(38);
  },
  'casting-statics-thalia-guardian-of-thraben-viewer-noncreature-tax': (r) => {
    expect(r.player('P2').life).toBe(38);
    const mountains = named(r, 'Mountain').filter((perm) => perm.controllerId === 'P1');
    expect(mountains).toHaveLength(2);
    expect(mountains.every((perm) => perm.tapped)).toBe(true);
  },
  'casting-statics-torbran-thane-of-red-fell-viewer-plus-two': (r) => {
    expect(r.player('P2').life).toBe(36);
  },
  'casting-statics-fiery-emancipation-viewer-triple': (r) => {
    expect(r.player('P2').life).toBe(34);
  },
  'casting-statics-knight-of-dawn-s-light-viewer-plus-first': (r) => {
    expect(r.picked).toHaveLength(1);
    expect(r.player('P1').life).toBe(48);
  },
  'casting-statics-rhox-faithmender-viewer-twice-first': (r) => {
    expect(r.picked).toHaveLength(1);
    expect(r.player('P1').life).toBe(47);
  },
  'casting-statics-boon-reflection-viewer-payment-order': (r) => {
    // 1 + (1 + 1) x 2 x 2 - 8: only the plus-first order pays, and the payment applies it.
    expect(r.done).toEqual(['CS Lab Mending']);
    // The payment made the order choice the plan proved; P1 was never asked.
    expect(
      r.seen.some((seen) =>
        seen.actions.some((action) => action.description.includes('gain that much life plus 1')),
      ),
    ).toBe(false);
    expect(r.permanent('Pristine Talisman')!.tapped).toBe(true);
    expect(r.player('P1').life).toBe(1);
    expect(zoneNames(r.player('P1').graveyard)).toContain('CS Lab Mending');
  },
};

describe('Casting-statics Card Test Lab scenarios', () => {
  it('declares the stable catalog for the casting statics and replacements', () => {
    expect(CASTING_STATICS_ALL_SCENARIOS).toEqual(CASTING_STATICS_SCENARIOS);
    const ids = CASTING_STATICS_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(CASTING_STATICS_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      ids.length,
    );
    expect(Object.keys(PLANS).sort()).toEqual([...ids].sort());
    expect(Object.keys(CHECKS).sort()).toEqual([...ids].sort());
  });

  it.each(CASTING_STATICS_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(canonicalSha256(pin.card)).toBe(pin.sha256);
      const scenario = castingStaticsScenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      const valid = castingStaticsClauseIds(pin.card);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      for (const clauseId of scenario.metadata.clauseIds) expect(valid).toContain(clauseId);
    },
  );

  it.each(CASTING_STATICS_SCENARIOS)('$id plays through the production decision path', ({ id }) => {
    const result = run(id);
    expect(result.state.eventLog.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.done).toEqual(
      PLANS[id]!.steps.slice(0, result.done.length).map((step) => step.cast ?? step.activate),
    );
    CHECKS[id]!(result);
  });
});
