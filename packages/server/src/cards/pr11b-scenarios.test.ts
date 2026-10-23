import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { PR11B_ALL_SCENARIOS } from './pr11b-scenario-catalog';
import { PR11B_SCENARIOS, pr11bScenario } from './pr11b-scenarios';

const manifest = JSON.parse(
  readFileSync(new URL('../../fixtures/card-verification-manifest.json', import.meta.url), 'utf8'),
) as { cards: Record<string, { clauses?: { id: string; viewerScenarioIds: string[] }[] }> };

const pinFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/engine/tests/fixtures/coverage-pr11-oracle.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cards: { sha256: string; card: OracleCard }[] };

/** One P1 priority action: cast a hand card or activate an ability, choosing targets by name. */
interface Step {
  cast?: string;
  /** A land played from hand: the offer's description is `Play <name>`. */
  play?: string;
  activate?: string;
  /** The offer's description must also contain this (a split half, a back face, a fuse). */
  includes?: string;
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
  'pr11b-malakir-rebirth-viewer-return': {
    steps: [
      { cast: 'Malakir Rebirth', targets: ['PR11b Lab Bear'] },
      { cast: 'PR11b Lab Shock', targets: ['PR11b Lab Bear'], whenEmpty: true },
    ],
  },
  'pr11b-malakir-rebirth-viewer-land-face': {
    steps: [{ play: 'Malakir Mire' }],
  },
  'pr11b-valakut-awakening-viewer-redraw': {
    steps: [{ cast: 'Valakut Awakening' }],
    answers: [
      /Put on bottom PR11b Lab Bear/,
      /Put on bottom PR11b Lab Relic/,
      /^Done choosing cards$/,
      /^Choose a new bottom order$/,
      /Put PR11b Lab Relic next on the bottom/,
    ],
  },
  'pr11b-valakut-awakening-viewer-land-face': { steps: [{ play: 'Valakut Stoneforge' }] },
  'pr11b-defacing-duskmage-viewer-prepared': {
    steps: [{ cast: "Vandal's Edit" }],
  },
  'pr11b-defacing-duskmage-viewer-first-draw': { steps: [] },
  'pr11b-eiganjo-dynastorian-viewer-prepared': {
    steps: [{ cast: 'Replenish' }],
    attacks: { 'Eiganjo Dynastorian': 'P2', 'PR11b Lab Bear': 'P2' },
  },
  'pr11b-eiganjo-dynastorian-viewer-one-attacker': {
    steps: [],
    attacks: { 'Eiganjo Dynastorian': 'P2' },
  },
  'pr11b-wandering-archaic-viewer-copy': { steps: [], answers: [/^Copy /, /^Target P2$/] },
  'pr11b-wandering-archaic-viewer-paid': { steps: [] },
  'pr11b-wear-tear-viewer-fused': {
    steps: [
      {
        cast: 'Wear // Tear',
        includes: 'fused',
        targets: ['PR11b Lab Relic', 'PR11b Lab Charm'],
      },
    ],
  },
  'pr11b-wear-tear-viewer-half': {
    steps: [{ cast: 'Tear', includes: 'as Tear', targets: ['PR11b Lab Charm'] }],
  },
  'pr11b-the-war-in-heaven-viewer-chapter-one': { steps: [{ cast: 'The War in Heaven' }] },
  'pr11b-the-war-in-heaven-viewer-chapter-three': {
    steps: [],
    answers: [/^Target PR11b Lab Bear$/, /^Target PR11b Lab Red Bear$/, /^Target PR11b Lab Giant$/],
  },
  'pr11b-intermediate-chirography-viewer-level-two': {
    steps: [{ activate: 'Gain Class level 2' }, { cast: 'PR11b Lab Drain', whenEmpty: true }],
  },
  'pr11b-intermediate-chirography-viewer-level-one': {
    steps: [{ cast: 'PR11b Lab Drain' }],
  },
  'pr11b-urza-s-saga-viewer-construct': {
    steps: [{ play: "Urza's Saga" }, { activate: '{2}, {T}' }],
  },
  'pr11b-urza-s-saga-viewer-chapter-three': { steps: [], answers: [/PR11b Lab Bauble/] },
  'pr11b-legion-s-landing-viewer-transform': {
    steps: [],
    attacks: {
      'PR11b Lab Bear': 'P2',
      'PR11b Lab Red Bear': 'P2',
      'PR11b Lab Pinger': 'P2',
    },
  },
  'pr11b-legion-s-landing-viewer-two-attackers': {
    steps: [],
    attacks: { 'PR11b Lab Bear': 'P2', 'PR11b Lab Red Bear': 'P2' },
  },
  'pr11b-dollmaker-s-shop-viewer-unlock': {
    steps: [
      { cast: "Dollmaker's Shop", includes: "as Dollmaker's Shop" },
      { activate: 'Unlock Porcelain Gallery', whenEmpty: true },
    ],
  },
  'pr11b-dollmaker-s-shop-viewer-toy-attack': {
    steps: [{ cast: "Dollmaker's Shop", includes: "as Dollmaker's Shop" }],
    attacks: { 'PR11b Lab Bear': 'P2', 'PR11b Lab Red Bear': 'P2' },
  },
  'pr11b-mila-crafty-companion-viewer-walker-attack': { steps: [] },
  'pr11b-mila-crafty-companion-viewer-lukka': {
    steps: [
      { cast: 'Lukka, Wayward Bonder', includes: 'back face' },
      { activate: 'Return target creature', whenEmpty: true },
    ],
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
  const scenario = pr11bScenario(id, `server-${id}` as never);
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
    const block = request.legalActions.find((option) => option.type === 'blockDeclaration');
    if (block !== undefined) {
      action = block;
      targets = (block.targets ?? []).map((slot) => ({ slot: slot.slot, choice: '__no_block__' }));
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
        next.play !== undefined
          ? option.type === 'playLand' && option.description === `Play ${next.play}`
          : next.cast !== undefined
            ? option.type === 'castSpell' &&
              option.description.startsWith(`Cast ${next.cast}`) &&
              option.description.includes(next.includes ?? '')
            : option.type === 'activateAbility' &&
              option.description.includes(next.activate!) &&
              option.description.includes(next.includes ?? ''),
      );
      if (action !== undefined) {
        steps.shift();
        done.push(next.play ?? next.cast ?? next.activate!);
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
const CHECKS: Record<string, (result: Result) => void> = {
  'pr11b-malakir-rebirth-viewer-return': (r) => {
    expect(r.done).toEqual(['Malakir Rebirth', 'PR11b Lab Shock']);
    expect(r.player('P1').life).toBe(38);
    // The Bear died to Lab Shock and came back as a new, tapped object.
    expect(zoneNames(r.player('P1').graveyard)).not.toContain('PR11b Lab Bear');
    expect(zoneNames(r.player('P1').graveyard)).toContain('PR11b Lab Shock');
    expect(r.permanent('PR11b Lab Bear')!.tapped).toBe(true);
  },
  'pr11b-malakir-rebirth-viewer-land-face': (r) => {
    expect(r.done).toEqual(['Malakir Mire']);
    expect(r.permanent('Malakir Mire')!.tapped).toBe(true);
    expect(r.chars('Malakir Mire').types).toEqual(['Land']);
  },
  'pr11b-valakut-awakening-viewer-redraw': (r) => {
    expect(r.picked).toEqual([
      'Put on bottom PR11b Lab Bear',
      'Put on bottom PR11b Lab Relic',
      'Done choosing cards',
      'Choose a new bottom order',
      'Put PR11b Lab Relic next on the bottom',
    ]);
    const p1 = r.player('P1');
    // The Trinket stayed; the two bottomed cards were replaced by three drawn.
    expect(p1.hand).toHaveLength(1 + 3);
    expect(zoneNames(p1.hand)).toContain('PR11b Lab Trinket');
    expect(zoneNames(p1.hand)).not.toContain('PR11b Lab Bear');
    expect(zoneNames(p1.hand)).not.toContain('PR11b Lab Relic');
    expect(p1.library.slice(-2).map((item) => item.name)).toEqual([
      'PR11b Lab Relic',
      'PR11b Lab Bear',
    ]);
  },
  'pr11b-valakut-awakening-viewer-land-face': (r) => {
    expect(r.done).toEqual(['Valakut Stoneforge']);
    expect(r.permanent('Valakut Stoneforge')!.tapped).toBe(true);
    expect(r.chars('Valakut Stoneforge').types).toEqual(['Land']);
  },
  'pr11b-defacing-duskmage-viewer-prepared': (r) => {
    // The copy was offered only once P2's second draw had prepared Duskmage, and casting it
    // unprepares it.
    expect(r.done).toEqual(["Vandal's Edit"]);
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR11b Lab Divination');
    expect(r.permanent('Defacing Duskmage')!.prepared).toBeUndefined();
    expect(r.player('P1').hand).toHaveLength(1 + 2);
    expect(r.state.players.map((p) => p.life)).toEqual([38, 38, 38, 38]);
    expect(zoneNames(r.state.exile)).toEqual([]);
  },
  'pr11b-defacing-duskmage-viewer-first-draw': (r) => {
    expect(zoneNames(r.player('P2').graveyard)).toContain('PR11b Lab Cantrip');
    expect(r.player('P2').hand).toHaveLength(1);
    expect(r.permanent('Defacing Duskmage')!.prepared).toBeUndefined();
    expect(zoneNames(r.state.exile)).toEqual([]);
    for (const entry of r.seen.filter((seen) => seen.player === 'P1'))
      expect(entry.actions.some((action) => action.description.includes("Vandal's Edit"))).toBe(
        false,
      );
    expect(r.state.players.map((p) => p.life)).toEqual([40, 40, 40, 40]);
  },
  'pr11b-eiganjo-dynastorian-viewer-prepared': (r) => {
    expect(r.done).toEqual(['Replenish']);
    expect(zoneNames(r.state.battlefield)).toContain('PR11b Lab Charm');
    expect(r.player('P1').graveyard).toHaveLength(0);
    expect(r.permanent('Eiganjo Dynastorian')!.prepared).toBeUndefined();
    expect(r.player('P2').life).toBe(36);
  },
  'pr11b-eiganjo-dynastorian-viewer-one-attacker': (r) => {
    expect(r.done).toEqual([]);
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['PR11b Lab Charm']);
    expect(r.permanent('PR11b Lab Charm')).toBeUndefined();
    expect(r.permanent('Eiganjo Dynastorian')!.prepared).toBeUndefined();
    for (const entry of r.seen.filter((seen) => seen.player === 'P1'))
      expect(entry.actions.some((action) => action.description.includes('Replenish'))).toBe(false);
    expect(r.player('P2').life).toBe(38);
  },
  'pr11b-wandering-archaic-viewer-copy': (r) => {
    expect(r.picked).toEqual(['Copy PR11b Lab Shock', 'Target P2']);
    // The original hits P3 and the copy, retargeted, hits P2.
    expect(r.state.players.map((p) => p.life)).toEqual([40, 38, 38, 40]);
  },
  'pr11b-wandering-archaic-viewer-paid': (r) => {
    expect(r.picked).toEqual([]);
    expect(
      r.seen.some(
        (entry) => entry.player === 'P1' && entry.actions.some((a) => a.type === 'accept'),
      ),
    ).toBe(false);
    expect(r.state.players.map((p) => p.life)).toEqual([40, 40, 38, 40]);
    expect(r.state.battlefield.filter((p) => p.controllerId === 'P2' && !p.tapped)).toEqual([]);
  },
  'pr11b-wear-tear-viewer-fused': (r) => {
    expect(r.done).toEqual(['Wear // Tear']);
    expect(zoneNames(r.player('P2').graveyard).sort()).toEqual([
      'PR11b Lab Charm',
      'PR11b Lab Relic',
    ]);
    expect(r.state.battlefield.filter((p) => p.controllerId === 'P2')).toEqual([]);
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['Wear // Tear']);
  },
  'pr11b-wear-tear-viewer-half': (r) => {
    expect(r.done).toEqual(['Tear']);
    expect(zoneNames(r.player('P2').graveyard)).toEqual(['PR11b Lab Charm']);
    expect(r.permanent('PR11b Lab Relic')).toBeDefined();
  },
  'pr11b-the-war-in-heaven-viewer-chapter-one': (r) => {
    expect(r.done).toEqual(['The War in Heaven']);
    expect(r.permanent('The War in Heaven')!.counters['lore']).toBe(1);
    expect(r.player('P1').life).toBe(37);
    expect(r.player('P1').hand).toHaveLength(1 + 3);
  },
  'pr11b-the-war-in-heaven-viewer-chapter-three': (r) => {
    expect(r.picked).toEqual([
      'Target PR11b Lab Bear',
      'Target PR11b Lab Red Bear',
      'Target PR11b Lab Giant',
    ]);
    for (const name of ['PR11b Lab Bear', 'PR11b Lab Red Bear', 'PR11b Lab Giant']) {
      expect(r.permanent(name)!.counters['necrodermis']).toBe(1);
      expect(r.chars(name).types).toEqual(['Creature', 'Artifact']);
    }
    expect(r.permanent('The War in Heaven')).toBeUndefined();
    expect(zoneNames(r.player('P1').graveyard)).toEqual(['The War in Heaven']);
  },
  'pr11b-intermediate-chirography-viewer-level-two': (r) => {
    expect(r.done).toEqual(['Gain Class level 2', 'PR11b Lab Drain']);
    expect(r.permanent('Intermediate Chirography')!.classLevel).toBe(2);
    expect(r.player('P1').life).toBe(38);
    expect(r.permanent('PR11b Lab Bear')!.counters['+1/+1']).toBe(1);
  },
  'pr11b-intermediate-chirography-viewer-level-one': (r) => {
    expect(r.done).toEqual(['PR11b Lab Drain']);
    expect(r.permanent('Intermediate Chirography')!.classLevel ?? 1).toBe(1);
    expect(r.player('P1').life).toBe(38);
    expect(r.permanent('PR11b Lab Bear')!.counters['+1/+1']).toBeUndefined();
  },
  'pr11b-urza-s-saga-viewer-construct': (r) => {
    expect(r.done).toEqual(["Urza's Saga", '{2}, {T}']);
    expect(r.permanent("Urza's Saga")!.counters['lore']).toBe(2);
    expect(r.permanent("Urza's Saga")!.tapped).toBe(true);
    // Chapter I gave it "{T}: Add {C}".
    expect(r.chars("Urza's Saga").manaAbilities.map((ability) => ability.units)).toEqual([[['C']]]);
    // The Construct counts itself and PR11b Lab Relic.
    expect(r.chars('Construct').types).toEqual(['Artifact', 'Creature']);
    expect([r.chars('Construct').power, r.chars('Construct').toughness]).toEqual([2, 2]);
  },
  'pr11b-urza-s-saga-viewer-chapter-three': (r) => {
    expect(r.picked).toEqual(['Put PR11b Lab Bauble onto the battlefield']);
    expect(r.permanent('PR11b Lab Bauble')).toBeDefined();
    // The {3} Relic is not a legal find.
    for (const entry of r.seen)
      expect(entry.actions.some((action) => action.description.includes('PR11b Lab Relic'))).toBe(
        false,
      );
    expect(r.permanent("Urza's Saga")).toBeUndefined();
    expect(zoneNames(r.player('P1').graveyard)).toEqual(["Urza's Saga"]);
  },
  'pr11b-legion-s-landing-viewer-transform': (r) => {
    expect(r.permanent("Legion's Landing")).toBeUndefined();
    expect(r.chars('Adanto, the First Fort').types).toEqual(['Land']);
    expect(r.player('P2').life).toBe(40 - 2 - 2 - 1);
  },
  'pr11b-legion-s-landing-viewer-two-attackers': (r) => {
    expect(r.permanent("Legion's Landing")!.transformed).toBe(false);
    expect(r.permanent('Adanto, the First Fort')).toBeUndefined();
    expect(r.player('P2').life).toBe(40 - 2 - 2);
  },
  'pr11b-dollmaker-s-shop-viewer-unlock': (r) => {
    expect(r.done).toEqual(["Dollmaker's Shop", 'Unlock Porcelain Gallery']);
    expect(r.permanent("Dollmaker's Shop // Porcelain Gallery")!.unlockedDoors).toEqual([
      'left',
      'right',
    ]);
    // Three creatures, so each has base 3/3 (the Pinger is printed 1/1).
    for (const name of ['PR11b Lab Bear', 'PR11b Lab Red Bear', 'PR11b Lab Pinger'])
      expect([r.chars(name).power, r.chars(name).toughness]).toEqual([3, 3]);
  },
  'pr11b-dollmaker-s-shop-viewer-toy-attack': (r) => {
    expect(r.done).toEqual(["Dollmaker's Shop"]);
    expect(r.permanent("Dollmaker's Shop")!.unlockedDoors).toEqual(['left']);
    const toy = r.chars('Toy');
    expect([toy.types, toy.subtypes, toy.colors, toy.power, toy.toughness]).toEqual([
      ['Artifact', 'Creature'],
      ['Toy'],
      ['W'],
      1,
      1,
    ]);
    expect(r.player('P2').life).toBe(36);
  },
  'pr11b-mila-crafty-companion-viewer-walker-attack': (r) => {
    // The Bear's two damage took the attacked walker from 3 +1 to 2; the other walker kept its +1.
    expect(r.permanent('PR11b Lab Walker')!.counters['loyalty']).toBe(3 + 1 - 2);
    expect(r.permanent('PR11b Lab Second Walker')!.counters['loyalty']).toBe(2 + 1);
    expect(r.state.players.map((p) => p.life)).toEqual([40, 40, 40, 40]);
  },
  'pr11b-mila-crafty-companion-viewer-lukka': (r) => {
    expect(r.done).toEqual(['Lukka, Wayward Bonder', 'Return target creature']);
    expect(r.permanent('Lukka, Wayward Bonder')!.counters['loyalty']).toBe(3);
    expect(r.chars('Lukka, Wayward Bonder').types).toEqual(['Planeswalker']);
    expect(r.chars('PR11b Lab Bear').keywords).toContain('haste');
    expect(r.player('P1').graveyard).toHaveLength(0);
  },
};

describe('PR11b Card Test Lab scenarios', () => {
  it('declares the stable catalog for the twelve layout cards', () => {
    expect(PR11B_ALL_SCENARIOS).toEqual(PR11B_SCENARIOS);
    expect(new Set(PR11B_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
      PR11B_SCENARIOS.length,
    );
    expect(new Set(PR11B_SCENARIOS.map((scenario) => scenario.title)).size).toBe(
      PR11B_SCENARIOS.length,
    );
    expect(new Set(PR11B_SCENARIOS.map((scenario) => scenario.cardName)).size).toBe(12);
    expect(Object.keys(PLANS).sort()).toEqual(PR11B_SCENARIOS.map(({ id }) => id).sort());
    expect(Object.keys(CHECKS).sort()).toEqual(PR11B_SCENARIOS.map(({ id }) => id).sort());
  });

  it.each(PR11B_SCENARIOS)(
    '$id binds the exact pinned Oracle text and real ordered clauses',
    ({ id, cardName }) => {
      const pin = pinFile.cards.find((entry) => entry.card.name === cardName)!;
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      const scenario = pr11bScenario(id, `pin-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(pin.sha256);
      // The manifest's clauses for this card that name this scenario, in order: the back faces'
      // and reminder clauses are not lines of the pinned front-face text.
      const valid = (manifest.cards[pin.card.oracleId]?.clauses ?? [])
        .filter((clause) => clause.viewerScenarioIds.includes(id))
        .map((clause) => clause.id);
      expect(scenario.metadata.clauseIds).toEqual(valid);
      expect(valid.length).toBeGreaterThan(0);
    },
  );

  it.each(PR11B_SCENARIOS)('$id plays through the production decision path', ({ id }) => {
    const result = run(id);
    expect(result.state.eventLog.some((event) => event.type === 'engineHalt')).toBe(false);
    expect(result.done).toEqual(
      PLANS[id]!.steps.slice(0, result.done.length).map(
        (step) => step.play ?? step.cast ?? step.activate,
      ),
    );
    CHECKS[id]!(result);
  });
});
