import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { PR11_ALL_SCENARIOS } from './pr11-scenario-catalog';
import { PR11_SCENARIOS, pr11Scenario } from './pr11-scenarios';

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/coverage-pr11-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cards: { sha256: string; card: OracleCard }[] };

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

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

const PLANS: Record<string, Plan> = {
  'pr11-arcane-lighthouse-viewer-positive': {
    steps: [
      { activate: 'Arcane Lighthouse: {1}, {T}' },
      { cast: 'PR11 Lab Shock', targets: ['PR11 Lab Hexproof Bear'], whenEmpty: true },
    ],
  },
  'pr11-arcane-lighthouse-viewer-negative': {
    steps: [{ cast: 'PR11 Lab Shock', targets: ['PR11 Lab Hexproof Bear'] }],
  },
  'pr11-smokestack-viewer-soot': {
    steps: [],
    // Place the sacrifice trigger first so the soot counter is added before it resolves.
    answers: [/sacrifices a permanent for each soot counter/, /^Yes$/, /PR11 Lab Bear/],
  },
  'pr11-smokestack-viewer-sacrifice': { steps: [] },
  'pr11-angel-s-grace-viewer-split-second': {
    steps: [{ cast: 'PR11 Lab Trinket' }, { cast: "Angel's Grace", whenEmpty: true }],
  },
  'pr11-angel-s-grace-viewer-life-floor': { steps: [{ cast: "Angel's Grace" }] },
  'pr11-gut-true-soul-zealot-viewer-sacrifice': {
    steps: [],
    attacks: { 'Gut, True Soul Zealot': 'P2' },
    answers: [/^Yes$/, /PR11 Lab Bear/],
  },
  'pr11-gut-true-soul-zealot-viewer-decline': {
    steps: [],
    attacks: { 'Gut, True Soul Zealot': 'P2' },
    answers: [/^No$/],
  },
  'pr11-out-of-the-tombs-viewer-upkeep': { steps: [] },
  'pr11-out-of-the-tombs-viewer-empty-library': { steps: [] },
  'pr11-caged-sun-viewer-chosen-color': { steps: [{ cast: 'Caged Sun' }], answers: [/^Red$/] },
  'pr11-caged-sun-viewer-mana': {
    steps: [
      { cast: 'Caged Sun' },
      { cast: 'PR11 Lab Fire Bolt', targets: ['P2'], whenEmpty: true },
    ],
    answers: [/^Red$/],
  },
  'pr11-caged-sun-viewer-other-color': {
    steps: [
      { cast: 'Caged Sun' },
      { cast: 'PR11 Lab Fire Bolt', targets: ['P2'], whenEmpty: true },
    ],
    answers: [/^Green$/],
  },
  'pr11-mystic-remora-viewer-draw': { steps: [], answers: [/^Yes$/] },
  'pr11-mystic-remora-viewer-pay-upkeep': { steps: [], answers: [/^Pay \{1\}$/] },
  'pr11-mystic-remora-viewer-skip-upkeep': { steps: [], answers: [/^Don't pay \{1\}$/] },
  'pr11-chrome-mox-viewer-imprint': {
    steps: [{ cast: 'Chrome Mox' }, { cast: 'PR11 Lab Shock', targets: ['P2'], whenEmpty: true }],
    answers: [/PR11 Lab Red Bear/],
  },
  'pr11-chrome-mox-viewer-no-imprint': {
    steps: [{ cast: 'Chrome Mox' }, { cast: 'PR11 Lab Shock', targets: ['P2'], whenEmpty: true }],
    answers: [/^Exile nothing$/],
  },
  'pr11-gemstone-caverns-viewer-luck': {
    steps: [{ cast: 'PR11 Lab Shock', targets: ['P2'] }],
  },
  'pr11-gemstone-caverns-viewer-no-luck': {
    steps: [{ cast: 'PR11 Lab Shock', targets: ['P2'] }],
  },
  'pr11-teferi-s-protection-viewer-protection': { steps: [{ cast: "Teferi's Protection" }] },
  'pr11-teferi-s-protection-viewer-phase-in': { steps: [{ cast: "Teferi's Protection" }] },
  'pr11-mana-vault-viewer-mana': { steps: [{ cast: 'PR11 Lab Relic' }] },
  'pr11-mana-vault-viewer-pay-untap': { steps: [], answers: [/^Pay \{4\}$/] },
  'pr11-mana-vault-viewer-damage': { steps: [], answers: [/^Don't pay$/] },
  'pr11-the-one-ring-viewer-cast': { steps: [{ cast: 'The One Ring' }] },
  'pr11-the-one-ring-viewer-draw': { steps: [{ activate: 'The One Ring: {T}' }] },
  'pr11-the-one-ring-viewer-upkeep': { steps: [] },
  'pr11-clever-concealment-viewer-phase-out': {
    steps: [{ cast: 'Clever Concealment' }],
    answers: [/PR11 Lab Bear/, /PR11 Lab Relic/],
  },
  'pr11-clever-concealment-viewer-convoke': {
    steps: [{ cast: 'Clever Concealment' }],
    answers: [/^Target PR11 Lab Bear$/, /^Choose no more targets$/],
  },
  'pr11-shanna-sisay-s-legacy-viewer-power': { steps: [] },
  'pr11-shanna-sisay-s-legacy-viewer-ability-target': { steps: [] },
  'pr11-shanna-sisay-s-legacy-viewer-spell-target': { steps: [] },
  'pr11-basri-s-lieutenant-viewer-enters': {
    steps: [{ cast: "Basri's Lieutenant" }],
    answers: [/PR11 Lab Bear/],
  },
  'pr11-basri-s-lieutenant-viewer-multicolored': { steps: [] },
  'pr11-basri-s-lieutenant-viewer-dies': {
    steps: [{ cast: 'PR11 Lab Fire Bolt', targets: ['PR11 Lab Red Bear'] }],
  },
  'pr11-negative-zone-portal-viewer-creature': {
    steps: [{ activate: 'Negative Zone Portal: {2}, {T}' }],
  },
  'pr11-negative-zone-portal-viewer-noncreature': {
    steps: [{ activate: 'Negative Zone Portal: {2}, {T}' }],
  },
  'pr11-spirit-mantle-viewer-cast': {
    steps: [{ cast: 'Spirit Mantle', targets: ['PR11 Lab Bear'] }],
  },
  'pr11-spirit-mantle-viewer-ability-target': { steps: [] },
  'pr11-unquestioned-authority-viewer-cast': {
    steps: [{ cast: 'Unquestioned Authority', targets: ['PR11 Lab Bear'] }],
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
  const scenario = pr11Scenario(id, `server-${id}` as never);
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
/** P1's priority decisions taken while the named permanent was on the battlefield. */
const p1PriorityWith = (result: Result, name: string) =>
  result.seen.filter(
    (entry) =>
      entry.player === 'P1' &&
      entry.battlefield.includes(name) &&
      entry.actions.some((action) => action.type === 'pass'),
  );
/**
 * Target options offered to `seat` for an action whose description starts with `prefix`, after
 * `after` (a spell) first left the stack when given.
 */
const targetOptions = (result: Result, seat: string, prefix: string, after?: string) =>
  result.seen
    .filter(
      (entry, index) =>
        entry.player === seat &&
        (after === undefined ||
          (entry.stack.length === 0 &&
            result.seen.slice(0, index).some((earlier) => earlier.stack.includes(after)))),
    )
    .flatMap((entry) => entry.actions.filter((action) => action.description.startsWith(prefix)))
    .flatMap((action) => action.targets.flat());

const CHECKS: Record<string, (result: Result) => void> = {
  'pr11-arcane-lighthouse-viewer-positive': (r) => {
    expect(r.done).toEqual(['Arcane Lighthouse: {1}, {T}', 'PR11 Lab Shock']);
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR11 Lab Hexproof Bear');
  },
  'pr11-arcane-lighthouse-viewer-negative': (r) => {
    expect(targetOptions(r, 'P1', 'Cast PR11 Lab Shock')).not.toContain('PR11 Lab Hexproof Bear');
    expect(r.permanent('PR11 Lab Hexproof Bear')).toBeDefined();
  },
  'pr11-smokestack-viewer-soot': (r) => {
    expect(r.permanent('Smokestack')!.counters['soot']).toBe(1);
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['PR11 Lab Bear']);
  },
  'pr11-smokestack-viewer-sacrifice': (r) => {
    expect(r.permanent('Smokestack')!.counters['soot']).toBe(1);
    expect(r.state.battlefield.filter((perm) => perm.controllerId === 'P2')).toHaveLength(1);
    expect(r.player('P2').graveyard).toHaveLength(1);
  },
  'pr11-angel-s-grace-viewer-split-second': (r) => {
    const p2With = (spell: string) =>
      r.seen.filter((entry) => entry.player === 'P2' && entry.stack.includes(spell));
    // Control: P2 may respond to the Trinket with Lab Shock, so it is given priority.
    expect(
      p2With('PR11 Lab Trinket').some((entry) =>
        entry.actions.some((action) => action.description.startsWith('Cast PR11 Lab Shock')),
      ),
    ).toBe(true);
    // Split second leaves P2 nothing but passing while Grace is on the stack.
    expect(p2With("Angel's Grace")).toEqual([]);
    expect(r.player('P3').life).toBe(38);
  },
  'pr11-angel-s-grace-viewer-life-floor': (r) => {
    expect(r.player('P1').life).toBe(1);
    expect(r.player('P1').hasLost).toBe(false);
  },
  'pr11-gut-true-soul-zealot-viewer-sacrifice': (r) => {
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['PR11 Lab Bear']);
    const skeleton = r.permanent('Skeleton')!;
    expect(skeleton.tapped).toBe(true);
    expect(r.chars('Skeleton').power).toBe(4);
    expect(r.chars('Skeleton').keywords).toContain('menace');
    expect(r.player('P2').life).toBe(40 - 2 - 4);
  },
  'pr11-gut-true-soul-zealot-viewer-decline': (r) => {
    expect(r.permanent('Skeleton')).toBeUndefined();
    expect(r.permanent('PR11 Lab Bear')).toBeDefined();
    expect(r.player('P2').life).toBe(38);
  },
  'pr11-out-of-the-tombs-viewer-upkeep': (r) => {
    expect(r.permanent('Out of the Tombs')!.counters['eon']).toBe(2);
    expect(r.player('P1').graveyard).toHaveLength(2);
  },
  'pr11-out-of-the-tombs-viewer-empty-library': (r) => {
    expect(r.permanent('PR11 Lab Bear')).toBeDefined();
    expect(r.player('P1').graveyard).toHaveLength(0);
    expect(r.player('P1').hasLost).toBe(false);
  },
  'pr11-caged-sun-viewer-chosen-color': (r) => {
    expect(r.picked).toEqual(['Red']);
    expect(r.chars('PR11 Lab Red Bear').power).toBe(3);
    expect(r.chars('PR11 Lab Red Bear').toughness).toBe(3);
    expect(r.chars('PR11 Lab Bear').power).toBe(2);
  },
  'pr11-caged-sun-viewer-mana': (r) => {
    expect(r.done).toEqual(['Caged Sun', 'PR11 Lab Fire Bolt']);
    expect(r.player('P2').life).toBe(37);
  },
  'pr11-caged-sun-viewer-other-color': (r) => {
    expect(r.done).toEqual(['Caged Sun']);
    const after = p1PriorityWith(r, 'Caged Sun');
    expect(after.length).toBeGreaterThan(0);
    for (const entry of after)
      expect(entry.actions.map((action) => action.description)).not.toContain(
        'Cast PR11 Lab Fire Bolt ({R}{R})',
      );
    expect(r.player('P2').life).toBe(40);
  },
  'pr11-mystic-remora-viewer-draw': (r) => {
    expect(r.picked).toEqual(['Yes']);
    expect(r.player('P1').hand).toHaveLength(2);
    expect(r.player('P3').life).toBe(38);
  },
  'pr11-mystic-remora-viewer-pay-upkeep': (r) => {
    expect(r.permanent('Mystic Remora')!.counters['age']).toBe(1);
  },
  'pr11-mystic-remora-viewer-skip-upkeep': (r) => {
    expect(r.permanent('Mystic Remora')).toBeUndefined();
    expect(zoneNames(r.player('P1').graveyard)).toContain('Mystic Remora');
  },
  'pr11-chrome-mox-viewer-imprint': (r) => {
    expect(r.done).toEqual(['Chrome Mox', 'PR11 Lab Shock']);
    expect(zoneNames(r.state.exile)).toContain('PR11 Lab Red Bear');
    expect(r.player('P2').life).toBe(38);
  },
  'pr11-chrome-mox-viewer-no-imprint': (r) => {
    expect(r.done).toEqual(['Chrome Mox']);
    expect(zoneNames(r.state.exile)).toEqual([]);
    for (const entry of p1PriorityWith(r, 'Chrome Mox'))
      expect(entry.actions.map((action) => action.description)).not.toContain(
        'Cast PR11 Lab Shock ({R})',
      );
  },
  'pr11-gemstone-caverns-viewer-luck': (r) => {
    expect(r.done).toEqual(['PR11 Lab Shock']);
    expect(r.player('P2').life).toBe(38);
  },
  'pr11-gemstone-caverns-viewer-no-luck': (r) => {
    expect(r.done).toEqual([]);
    expect(r.player('P2').life).toBe(40);
  },
  'pr11-teferi-s-protection-viewer-protection': (r) => {
    expect(r.player('P1').life).toBe(40);
    const options = targetOptions(r, 'P2', 'Cast PR11 Lab Shock', "Teferi's Protection");
    expect(options).toContain('P3');
    expect(options).not.toContain('P1');
    expect(r.phasedOut).toEqual(['PR11 Lab Bear', 'Plains', 'Plains', 'Plains']);
    expect(r.state.battlefield.filter((perm) => perm.controllerId === 'P1')).toEqual([]);
    expect(zoneNames(r.state.exile)).toContain("Teferi's Protection");
  },
  'pr11-teferi-s-protection-viewer-phase-in': (r) => {
    expect(r.state.turnNumber).toBe(8);
    expect(r.phasedOut).toEqual([]);
    expect(r.permanent('PR11 Lab Bear')).toBeDefined();
  },
  'pr11-mana-vault-viewer-mana': (r) => {
    expect(r.permanent('PR11 Lab Relic')).toBeDefined();
    expect(r.permanent('Mana Vault')!.tapped).toBe(true);
  },
  'pr11-mana-vault-viewer-pay-untap': (r) => {
    expect(r.picked).toEqual(['Pay {4}']);
    expect(r.permanent('Mana Vault')!.tapped).toBe(false);
    expect(r.player('P1').life).toBe(40);
  },
  'pr11-mana-vault-viewer-damage': (r) => {
    expect(r.picked).toEqual(["Don't pay"]);
    expect(r.permanent('Mana Vault')!.tapped).toBe(true);
    expect(r.player('P1').life).toBe(39);
  },
  'pr11-the-one-ring-viewer-cast': (r) => {
    expect(r.permanent('The One Ring')).toBeDefined();
    expect(r.player('P1').life).toBe(40);
    const options = targetOptions(r, 'P2', 'Cast PR11 Lab Shock', 'The One Ring');
    expect(options).toContain('P3');
    expect(options).not.toContain('P1');
  },
  'pr11-the-one-ring-viewer-draw': (r) => {
    expect(r.permanent('The One Ring')!.counters['burden']).toBe(1);
    expect(r.player('P1').hand).toHaveLength(2);
  },
  'pr11-the-one-ring-viewer-upkeep': (r) => {
    expect(r.player('P1').life).toBe(38);
  },
  'pr11-clever-concealment-viewer-phase-out': (r) => {
    expect(r.phasedOut).toEqual(['PR11 Lab Bear', 'PR11 Lab Relic']);
    expect(r.state.battlefield.filter((perm) => perm.name === 'Plains')).toHaveLength(4);
  },
  'pr11-clever-concealment-viewer-convoke': (r) => {
    expect(r.done).toEqual(['Clever Concealment']);
    expect(r.phasedOut).toEqual(['PR11 Lab Bear']);
    // Two Plains and both creatures paid {2}{W}{W}: the untargeted creature stayed tapped.
    expect(r.permanent('PR11 Lab Red Bear')!.tapped).toBe(true);
  },
  'pr11-shanna-sisay-s-legacy-viewer-power': (r) => {
    expect(r.chars("Shanna, Sisay's Legacy").power).toBe(3);
    expect(r.chars("Shanna, Sisay's Legacy").toughness).toBe(3);
  },
  'pr11-shanna-sisay-s-legacy-viewer-ability-target': (r) => {
    const options = targetOptions(r, 'P2', 'PR11 Lab Pinger');
    expect(options).toContain('PR11 Lab Bear');
    expect(options).not.toContain("Shanna, Sisay's Legacy");
  },
  'pr11-shanna-sisay-s-legacy-viewer-spell-target': (r) => {
    expect(targetOptions(r, 'P2', 'Cast PR11 Lab Shock')).toContain("Shanna, Sisay's Legacy");
    expect(zoneNames(r.player('P1').graveyard)).toContain("Shanna, Sisay's Legacy");
  },
  'pr11-basri-s-lieutenant-viewer-enters': (r) => {
    expect(r.permanent('PR11 Lab Bear')!.counters['+1/+1']).toBe(1);
  },
  'pr11-basri-s-lieutenant-viewer-multicolored': (r) => {
    const options = targetOptions(r, 'P2', 'Cast PR11 Lab Gold Bolt');
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain("Basri's Lieutenant");
    expect(r.permanent("Basri's Lieutenant")).toBeDefined();
  },
  'pr11-basri-s-lieutenant-viewer-dies': (r) => {
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR11 Lab Red Bear');
    expect(r.permanent('Knight')).toBeDefined();
    expect(r.chars('Knight').keywords).toContain('vigilance');
  },
  'pr11-negative-zone-portal-viewer-creature': (r) => {
    expect(zoneNames(r.state.exile)).toContain('PR11 Lab Bear');
    expect(r.player('P1').hand).toHaveLength(2);
  },
  'pr11-negative-zone-portal-viewer-noncreature': (r) => {
    expect(zoneNames(r.state.exile)).toContain('PR11 Lab Shock');
    expect(r.player('P1').hand).toHaveLength(1);
  },
  'pr11-spirit-mantle-viewer-cast': (r) => {
    expect(r.chars('PR11 Lab Bear').power).toBe(3);
    expect(r.chars('PR11 Lab Bear').toughness).toBe(3);
  },
  'pr11-spirit-mantle-viewer-ability-target': (r) => {
    const options = targetOptions(r, 'P2', 'PR11 Lab Pinger');
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain('PR11 Lab Bear');
  },
  'pr11-unquestioned-authority-viewer-cast': (r) => {
    expect(r.permanent('Unquestioned Authority')!.attachedTo).toBe(
      r.permanent('PR11 Lab Bear')!.id,
    );
    expect(r.player('P1').hand).toHaveLength(2);
  },
};

describe('PR11 Card Test Lab scenarios', () => {
  it('declares the stable catalog for the eighteen protection and lifecycle cards', () => {
    expect(PR11_ALL_SCENARIOS).toEqual(PR11_SCENARIOS);
    expect(new Set(PR11_SCENARIOS.map((scenario) => scenario.id)).size).toBe(PR11_SCENARIOS.length);
    expect(new Set(PR11_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      PR11_SCENARIOS.length,
    );
    expect(new Set(PR11_SCENARIOS.map((scenario) => scenario.cardName)).size).toBe(18);
    expect(Object.keys(PLANS).sort()).toEqual(PR11_SCENARIOS.map(({ id }) => id).sort());
    expect(Object.keys(CHECKS).sort()).toEqual(PR11_SCENARIOS.map(({ id }) => id).sort());
  });

  it.each(PR11_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      const scenario = pr11Scenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      const valid = pin.card.oracleText
        .split('\n')
        .map((_, index) => `pr11-${slug(cardName)}-clause-${index + 1}`);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      for (const clauseId of scenario.metadata.clauseIds) expect(valid).toContain(clauseId);
    },
  );

  it.each(PR11_SCENARIOS)('$id plays through the production decision path', ({ id }) => {
    const result = run(id);
    expect(result.state.eventLog.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.done).toEqual(
      PLANS[id]!.steps.slice(0, result.done.length).map((step) => step.cast ?? step.activate),
    );
    CHECKS[id]!(result);
  });
});
