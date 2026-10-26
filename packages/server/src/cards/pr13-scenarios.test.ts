import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { PR13_ALL_SCENARIOS } from './pr13-scenario-catalog';
import { PR13_SCENARIOS, pr13ClauseIds, pr13Scenario } from './pr13-scenarios';

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/coverage-pr13-oracle.json',
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

const SECURITRON = 'Securitron Squadron';

const PLANS: Record<string, Plan> = {
  'pr13-master-of-ceremonies-viewer-money': { steps: [{ cast: 'PR13 Lab Gadget' }] },
  'pr13-securitron-squadron-viewer-squad-copy': {
    steps: [{ cast: SECURITRON, optionalCount: 1 }],
  },
  'pr13-securitron-squadron-viewer-nontoken': { steps: [{ cast: 'PR13 Lab Bear' }] },
  'pr13-confiscation-coup-viewer-zero-mana-value': {
    steps: [{ cast: 'Confiscation Coup', targets: ['PR13 Lab Ornament'] }],
    answers: [/^Pay 0 energy/],
  },
  'pr13-confiscation-coup-viewer-pay-mana-value': {
    steps: [{ cast: 'Confiscation Coup', targets: ['PR13 Lab Totem'] }],
    answers: [/^Pay 2 energy/],
  },
  'pr13-overwhelming-instinct-viewer-attacker-removed': {
    steps: [{ cast: 'PR13 Lab Shock', targets: ['PR13 Lab Bear'], whenStack: true }],
    attacks: { 'PR13 Lab Bear': 'P2', 'PR13 Lab Cub': 'P2', 'PR13 Lab Whelp': 'P2' },
  },
  'pr13-overwhelming-instinct-viewer-two-attackers': {
    steps: [],
    attacks: { 'PR13 Lab Bear': 'P2', 'PR13 Lab Cub': 'P2' },
  },
  'pr13-rakdos-charm-viewer-creature-sources': {
    steps: [{ cast: 'Rakdos Charm', mode: /each creature deals 1 damage/i }],
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
  const scenario = pr13Scenario(id, `server-${id}` as never);
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
  'pr13-master-of-ceremonies-viewer-money': (r) => {
    // P1 had no lands, so the Gadget was paid for by sacrificing P1's Treasure.
    expect(r.permanent('PR13 Lab Gadget')).toBeDefined();
    const treasures = named(r, 'Treasure').map((perm) => perm.controllerId);
    expect(treasures).toEqual(['P2']);
  },
  'pr13-securitron-squadron-viewer-squad-copy': (r) => {
    const squadrons = named(r, SECURITRON);
    expect(squadrons).toHaveLength(2);
    const token = squadrons.find((perm) => perm.isToken)!;
    const original = squadrons.find((perm) => !perm.isToken)!;
    // One counter from the copy's own trigger and one from the original's.
    expect(token.counters['+1/+1']).toBe(2);
    expect(original.counters['+1/+1'] ?? 0).toBe(0);
  },
  'pr13-securitron-squadron-viewer-nontoken': (r) => {
    expect(r.permanent('PR13 Lab Bear')).toBeDefined();
    expect(r.permanent('PR13 Lab Bear')!.counters['+1/+1'] ?? 0).toBe(0);
    expect(r.permanent(SECURITRON)!.counters['+1/+1'] ?? 0).toBe(0);
  },
  'pr13-confiscation-coup-viewer-zero-mana-value': (r) => {
    expect(r.permanent('PR13 Lab Ornament')!.controllerId).toBe('P1');
    expect(r.player('P1').energy).toBe(4);
  },
  'pr13-confiscation-coup-viewer-pay-mana-value': (r) => {
    expect(r.permanent('PR13 Lab Totem')!.controllerId).toBe('P1');
    expect(r.player('P1').energy).toBe(2);
  },
  'pr13-overwhelming-instinct-viewer-attacker-removed': (r) => {
    expect(r.permanent('PR13 Lab Bear')).toBeUndefined();
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR13 Lab Bear');
    expect(zoneNames(r.player('P1').hand)).toContain('PR13 Lab Relic');
    // Only the two surviving attackers connected.
    expect(r.player('P2').life).toBe(36);
  },
  'pr13-overwhelming-instinct-viewer-two-attackers': (r) => {
    expect(zoneNames(r.player('P1').hand)).not.toContain('PR13 Lab Relic');
    expect(zoneNames(r.player('P1').library)[0]).toBe('PR13 Lab Relic');
    expect(r.player('P2').life).toBe(36);
  },
  'pr13-rakdos-charm-viewer-creature-sources': (r) => {
    // The lifelinker's 1 damage to P1 is matched by its 1 life gained.
    expect(r.player('P1').life).toBe(40);
    // The bear's damage costs P2 a life; the infector's gives P2 a poison counter instead.
    expect(r.player('P2').life).toBe(39);
    expect(r.player('P2').poisonCounters).toBe(1);
  },
};

describe('PR13 Card Test Lab scenarios', () => {
  it('declares the stable catalog for the five cards fixed in the override review', () => {
    expect(PR13_ALL_SCENARIOS).toEqual(PR13_SCENARIOS);
    expect(new Set(PR13_SCENARIOS.map((scenario) => scenario.id)).size).toBe(PR13_SCENARIOS.length);
    expect(new Set(PR13_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      PR13_SCENARIOS.length,
    );
    expect(new Set(PR13_SCENARIOS.map((scenario) => scenario.cardName)).size).toBe(5);
    expect(Object.keys(PLANS).sort()).toEqual(PR13_SCENARIOS.map(({ id }) => id).sort());
    expect(Object.keys(CHECKS).sort()).toEqual(PR13_SCENARIOS.map(({ id }) => id).sort());
  });

  it.each(PR13_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      const scenario = pr13Scenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      const valid = pr13ClauseIds(pin.card);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      for (const clauseId of scenario.metadata.clauseIds) expect(valid).toContain(clauseId);
    },
  );

  it.each(PR13_SCENARIOS)('$id plays through the production decision path', ({ id }) => {
    const result = run(id);
    expect(result.state.eventLog.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.done).toEqual(
      PLANS[id]!.steps.slice(0, result.done.length).map((step) => step.cast ?? step.activate),
    );
    CHECKS[id]!(result);
  });
});
