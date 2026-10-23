import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { PR12_ALL_SCENARIOS } from './pr12-scenario-catalog';
import { PR12_SCENARIOS, pr12ClauseIds, pr12Scenario } from './pr12-scenarios';

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/coverage-pr12-oracle.json',
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
}

/** What P1 does in the viewer, expressed as engine actions. */
interface Plan {
  steps: Step[];
  /** Options P1 picks in non-priority decisions, matched against the description, in order. */
  answers?: RegExp[];
  /** Which defending seat each named creature attacks; the rest stay home. */
  attacks?: Record<string, string>;
}

const BLACK_BOLT = 'Black Bolt, Inhuman King';
const ZURGO = 'Zurgo and Ojutai';

const PLANS: Record<string, Plan> = {
  'pr12-black-bolt-inhuman-king-viewer-lethal-voice': { steps: [], answers: [/PR12 Lab Relic/] },
  'pr12-black-bolt-inhuman-king-viewer-noncreature-pump': {
    steps: [{ cast: 'PR12 Lab Relic' }],
    attacks: { [BLACK_BOLT]: 'P2' },
  },
  'pr12-black-bolt-inhuman-king-viewer-creature-spell': {
    steps: [{ cast: 'PR12 Lab Bear' }],
    attacks: { [BLACK_BOLT]: 'P2' },
  },
  'pr12-dingus-staff-viewer-opponent-creature': {
    steps: [{ cast: 'PR12 Lab Shock', targets: ['PR12 Lab Bear'] }],
  },
  'pr12-dingus-staff-viewer-own-creature': {
    steps: [{ cast: 'PR12 Lab Shock', targets: ['PR12 Lab Bear'] }],
  },
  'pr12-sivitri-dragon-master-viewer-attack-tax': {
    steps: [{ activate: 'Sivitri, Dragon Master: +1' }],
  },
  'pr12-sivitri-dragon-master-viewer-unaffordable-tax': {
    steps: [{ activate: 'Sivitri, Dragon Master: +1' }],
  },
  'pr12-sivitri-dragon-master-viewer-tutor': {
    steps: [{ activate: 'Sivitri, Dragon Master: −3' }],
    answers: [/PR12 Lab Dragon/],
  },
  'pr12-sivitri-dragon-master-viewer-wrath': {
    steps: [{ activate: 'Sivitri, Dragon Master: −7' }],
  },
  'pr12-zurgo-and-ojutai-viewer-return': {
    steps: [],
    attacks: { [ZURGO]: 'P2' },
    answers: [/PR12 Lab Relic/, /Zurgo and Ojutai/],
  },
  'pr12-zurgo-and-ojutai-viewer-keep': {
    steps: [],
    attacks: { [ZURGO]: 'P2' },
    answers: [/PR12 Lab Relic/, /^Return none$/],
  },
  'pr12-bloomvine-regent-claim-territory-viewer-claim-territory': {
    steps: [{ cast: 'Claim Territory' }],
    answers: [/^Put Forest onto the battlefield tapped$/, /^Put Forest into your hand$/],
  },
  'pr12-bloomvine-regent-claim-territory-viewer-enters': {
    steps: [{ cast: 'Bloomvine Regent // Claim Territory' }],
  },
  'pr12-marang-river-regent-coil-and-catch-viewer-coil-and-catch': {
    steps: [{ cast: 'Coil and Catch' }],
    answers: [/PR12 Lab Trinket/],
  },
  'pr12-marang-river-regent-coil-and-catch-viewer-enters': {
    steps: [{ cast: 'Marang River Regent // Coil and Catch' }],
    answers: [/^Target PR12 Lab Bear$/, /^Target PR12 Lab Relic$/],
  },
  'pr12-monster-manual-zoological-study-viewer-zoological-study': {
    steps: [
      { cast: 'Zoological Study' },
      { cast: 'Monster Manual // Zoological Study', whenEmpty: true },
    ],
    answers: [/PR12 Lab Bear/],
  },
  'pr12-monster-manual-zoological-study-viewer-put-creature': {
    steps: [{ activate: 'Monster Manual // Zoological Study: {1}{G}, {T}' }],
    answers: [/PR12 Lab Dragon/],
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
  const scenario = pr12Scenario(id, `server-${id}` as never);
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
      (next.whenEmpty !== true || ctx.state.stack.length === 0)
    ) {
      action = request.legalActions.find((option) =>
        next.cast !== undefined
          ? option.type === 'castSpell' && option.description.startsWith(`Cast ${next.cast} (`)
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
  const chars = (name: string) => computeCharacteristics(ctx, permanent(name)!);
  // A phased-out permanent is treated as though it doesn't exist (CR 702.26b): the engine holds
  // it aside until it phases in.
  const phasedOut = (state.phasedOut ?? []).map((record) => record.permanent.name).sort();
  return { scenario, ctx, state, seen, picked, done, player, permanent, chars, phasedOut };
}
type Result = ReturnType<typeof run>;

const zoneNames = (cards: readonly { name: string }[]) => cards.map((item) => item.name);

const SIVITRI = 'Sivitri, Dragon Master';
const loyalty = (result: Result) => result.permanent(SIVITRI)!.counters['loyalty'];

const CHECKS: Record<string, (result: Result) => void> = {
  'pr12-black-bolt-inhuman-king-viewer-lethal-voice': (r) => {
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR12 Lab Relic');
    expect(r.permanent(BLACK_BOLT)).toBeDefined();
  },
  'pr12-black-bolt-inhuman-king-viewer-noncreature-pump': (r) => {
    expect(r.permanent('PR12 Lab Relic')).toBeDefined();
    expect(r.player('P2').life).toBe(35);
  },
  'pr12-black-bolt-inhuman-king-viewer-creature-spell': (r) => {
    expect(r.permanent('PR12 Lab Bear')).toBeDefined();
    expect(r.player('P2').life).toBe(37);
  },
  'pr12-dingus-staff-viewer-opponent-creature': (r) => {
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR12 Lab Bear');
    expect(r.player('P2').life).toBe(38);
    expect(r.player('P1').life).toBe(40);
  },
  'pr12-dingus-staff-viewer-own-creature': (r) => {
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR12 Lab Bear');
    expect(r.player('P1').life).toBe(38);
    expect(r.player('P2').life).toBe(40);
  },
  'pr12-sivitri-dragon-master-viewer-attack-tax': (r) => {
    expect(loyalty(r)).toBe(5);
    // 2 life paid to attack, and the bear's 2 combat damage.
    expect(r.player('P2').life).toBe(38);
    expect(r.player('P1').life).toBe(38);
  },
  'pr12-sivitri-dragon-master-viewer-unaffordable-tax': (r) => {
    expect(loyalty(r)).toBe(5);
    expect(r.player('P2').life).toBe(1);
    expect(r.player('P1').life).toBe(40);
    expect(r.permanent('PR12 Lab Bear')!.tapped).toBe(false);
  },
  'pr12-sivitri-dragon-master-viewer-tutor': (r) => {
    expect(loyalty(r)).toBe(1);
    expect(zoneNames(r.player('P1').hand)).toContain('PR12 Lab Dragon');
    expect(zoneNames(r.player('P1').library)).not.toContain('PR12 Lab Dragon');
  },
  'pr12-sivitri-dragon-master-viewer-wrath': (r) => {
    expect(r.permanent('PR12 Lab Dragon')).toBeDefined();
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR12 Lab Bear');
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR12 Lab Bear');
  },
  'pr12-zurgo-and-ojutai-viewer-return': (r) => {
    expect(r.player('P2').life).toBe(36);
    expect(zoneNames(r.player('P1').hand)).toEqual(
      expect.arrayContaining(['PR12 Lab Relic', ZURGO]),
    );
    expect(zoneNames(r.player('P1').library).slice(-2).sort()).toEqual([
      'PR12 Lab Bear',
      'PR12 Lab Shock',
    ]);
  },
  'pr12-zurgo-and-ojutai-viewer-keep': (r) => {
    expect(r.permanent(ZURGO)).toBeDefined();
    expect(zoneNames(r.player('P1').hand)).toContain('PR12 Lab Relic');
  },
  'pr12-bloomvine-regent-claim-territory-viewer-claim-territory': (r) => {
    expect(r.picked).toEqual([
      'Put Forest onto the battlefield tapped',
      'Put Forest into your hand',
    ]);
    expect(r.state.battlefield.filter((perm) => perm.name === 'Forest')).toHaveLength(4);
    expect(zoneNames(r.player('P1').hand)).toContain('Forest');
    expect(zoneNames(r.player('P1').library)).toContain('Bloomvine Regent // Claim Territory');
  },
  'pr12-bloomvine-regent-claim-territory-viewer-enters': (r) => {
    expect(r.permanent('Bloomvine Regent // Claim Territory')).toBeDefined();
    expect(r.player('P1').life).toBe(43);
  },
  'pr12-marang-river-regent-coil-and-catch-viewer-coil-and-catch': (r) => {
    expect(r.player('P1').hand).toHaveLength(3);
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['PR12 Lab Trinket']);
    expect(zoneNames(r.player('P1').library)).toContain('Marang River Regent // Coil and Catch');
  },
  'pr12-marang-river-regent-coil-and-catch-viewer-enters': (r) => {
    expect(r.permanent('Marang River Regent // Coil and Catch')).toBeDefined();
    expect(zoneNames(r.player('P2').hand).sort()).toEqual(['PR12 Lab Bear', 'PR12 Lab Relic']);
  },
  'pr12-monster-manual-zoological-study-viewer-zoological-study': (r) => {
    expect(r.picked).toEqual(['Return PR12 Lab Bear']);
    expect(zoneNames(r.player('P1').hand)).toContain('PR12 Lab Bear');
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR12 Lab Dragon');
    expect(r.permanent('Monster Manual // Zoological Study')).toBeDefined();
  },
  'pr12-monster-manual-zoological-study-viewer-put-creature': (r) => {
    expect(r.permanent('PR12 Lab Dragon')).toBeDefined();
    expect(zoneNames(r.player('P1').hand)).toEqual(['PR12 Lab Trinket']);
  },
};

describe('PR12 Card Test Lab scenarios', () => {
  it('declares the stable catalog for the seven reopened cards', () => {
    expect(PR12_ALL_SCENARIOS).toEqual(PR12_SCENARIOS);
    expect(new Set(PR12_SCENARIOS.map((scenario) => scenario.id)).size).toBe(PR12_SCENARIOS.length);
    expect(new Set(PR12_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      PR12_SCENARIOS.length,
    );
    expect(new Set(PR12_SCENARIOS.map((scenario) => scenario.cardName)).size).toBe(7);
    expect(Object.keys(PLANS).sort()).toEqual(PR12_SCENARIOS.map(({ id }) => id).sort());
    expect(Object.keys(CHECKS).sort()).toEqual(PR12_SCENARIOS.map(({ id }) => id).sort());
  });

  it.each(PR12_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      const scenario = pr12Scenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      const valid = pr12ClauseIds(pin.card);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      for (const clauseId of scenario.metadata.clauseIds) expect(valid).toContain(clauseId);
    },
  );

  it.each(PR12_SCENARIOS)('$id plays through the production decision path', ({ id }) => {
    const result = run(id);
    expect(result.state.eventLog.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.done).toEqual(
      PLANS[id]!.steps.slice(0, result.done.length).map((step) => step.cast ?? step.activate),
    );
    CHECKS[id]!(result);
  });
});
