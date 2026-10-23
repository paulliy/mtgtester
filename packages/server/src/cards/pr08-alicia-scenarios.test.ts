/**
 * PR08.14: Alicia Masters, Skilled Sculptor — Card Test Lab replay.
 *
 * Both scenarios run the printed {1}{R} creature through the production engine: real legality,
 * real payment chosen from the two Mountains, the real stack, real priority passes, real
 * resolution, the production combat phase, and the production end step. Nothing here arranges an
 * outcome: the assertions read the authoritative engine state and the complete event stream after
 * replaying the scenario, and the only difference the two runs are allowed to have is the one the
 * card itself draws — whether a noncreature spell went on the stack this turn.
 *
 * What the replay pins:
 *
 *  - {1}{R} was paid for, with both Mountains, through ordinary mana selection: two `tapForMana`
 *    events, a `castSpell` for P1, and a zone change off the stack into the battlefield;
 *  - the intervening if is read at the START of combat: exactly one `tokenCreated`, sequenced
 *    strictly between the `beginCombat` step and the `declareAttackers` step, and no token before
 *    it;
 *  - that Treasure is a real mana source — the only mana P1 still has once the Mountains are
 *    tapped — and P1 owns and controls it;
 *  - "Sense the Good" is the only ability that can move control back, and it resolves in the end
 *    step: in the run that pauses for input inside the end step, the decision is still taken while
 *    both stolen creatures are held by the wrong players, and only the resolution that follows
 *    returns them;
 *  - "all creatures they own" includes creatures the owner ALREADY controls: Alicia and P3's
 *    bystander each end the effect holding a fresh PERMANENT control record, which is what keeps
 *    an older temporary grant underneath them from taking them back later;
 *  - "all CREATURES they own" excludes a noncreature: P3's artifact stays exactly where it was,
 *    under P1, with no control record at all — and neither does the Treasure.
 *
 * The negative scenario casts no noncreature spell at all, so the intervening if is false: the
 * combat trigger is never put on the stack and no Treasure is ever created — while the end-step
 * trigger, which has no condition, still runs identically. The unused witness is still castable and
 * still in hand when the run ends, which is what proves the replay did not quietly cast it.
 */
import { readFileSync } from 'node:fs';
import type { DecisionProvider } from '@mtg/engine';
import type { GameEvent, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import { manaSourcesFor } from '../../../engine/src/state/queries';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { createCardTestScenario } from './card-test-scenarios';

type Mode = 'combat-treasure-and-owner-control' | 'no-noncreature-spell';

const ALICIA = 'Alicia Masters, Skilled Sculptor';
const WITNESS = 'Lab Priority Witness';
const TREASURE = 'Treasure';
const P1_OWNED_HELD_BY_P2 = 'Lab Reclaimed Ox';
const P2_OWNED_HELD_BY_P1 = 'Lab Borrowed Golem';
const P3_OWNED_NONCREATURE_HELD_BY_P1 = 'Lab Pledged Relic';
const P3_BYSTANDER = 'Lab Bystander Golem';
const COMBAT_TRIGGER =
  "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a Treasure token";
const END_STEP_TRIGGER =
  'At the beginning of your end step, each player gains control of all creatures they own';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
const aliciaPin = pins.find((entry) => entry.card.name === ALICIA);

interface BoardEntry {
  name: string;
  controllerId: string;
  ownerId: string;
  tapped: boolean;
}

interface Observation {
  phase: string;
  step: string | null;
  /** Battlefield order, so the arranged position itself is part of what is asserted. */
  entries: BoardEntry[];
  treasures: BoardEntry[];
  hand: string[];
}

type Replay = ReturnType<typeof replay>;

function replay(mode: Mode) {
  const scenario = createCardTestScenario(`alicia-masters-viewer-${mode}`, 'pr08-alicia-lab');
  expect(scenario, `scenario alicia-masters-viewer-${mode}`).not.toBeNull();
  const engine = scenario!.engine;
  const castsWitness = mode === 'combat-treasure-and-owner-control';
  const overrides: Partial<Record<string, DecisionProvider>> =
    scenario!.decisionProviderOverrides ?? {};
  const observations: Observation[] = [];
  const castOrder: string[] = [];
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    const state = engine.getState();
    const entries = state.battlefield.map((perm) => ({
      name: perm.name,
      controllerId: perm.controllerId,
      ownerId: perm.ownerId,
      tapped: perm.tapped,
    }));
    observations.push({
      phase: state.phase,
      step: state.step,
      entries,
      treasures: entries.filter((entry) => entry.name === TREASURE),
      hand: state.players.find((player) => player.id === 'P1')!.hand.map((card) => card.name),
    });
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 200) throw new Error(`Alicia Masters ${mode} failed to finish`);
    const request = step.request;
    if (request.decidingPlayer !== 'P1') {
      const provider = overrides[request.decidingPlayer];
      engine.submit(
        provider
          ? provider.decide(request)
          : {
              requestId: request.requestId,
              actionId: (
                request.legalActions.find((action) => action.type === 'pass') ??
                request.legalActions[0]!
              ).id,
            },
      );
      continue;
    }
    const offer = (name: string) =>
      request.legalActions.find(
        (action) => action.type === 'castSpell' && action.description.startsWith(`Cast ${name}`),
      );
    const alicia = offer(ALICIA);
    // The witness goes down only after Alicia has left the stack, so the two casts are sequential
    // rather than stacked, and both are in the main phase. In the negative run it is never taken.
    const witness =
      castsWitness && castOrder.length === 1 && state.stack.length === 0
        ? offer(WITNESS)
        : undefined;
    const chosen = alicia ?? witness;
    if (chosen !== undefined) castOrder.push(chosen.description);
    const pass =
      request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
    engine.submit({
      requestId: request.requestId,
      actionId: (chosen ?? pass).id,
      ...(((chosen ?? pass).targets ?? []).length === 0
        ? {}
        : {
            targets: (chosen ?? pass)!.targets!.map((slot) => ({
              slot: slot.slot,
              choice: slot.options[0] as string,
            })),
          }),
    });
  }
  const state = engine.getState();
  return {
    scenario: scenario!,
    state,
    ctx: (engine as unknown as { ctx: GameContext }).ctx,
    log: state.eventLog,
    observations,
    castOrder,
    haltReason: engine.getResult()?.haltReason ?? null,
  };
}

const last = (run: Replay): Observation => run.observations.at(-1)!;
const perm = (observation: Observation, name: string): BoardEntry | undefined =>
  observation.entries.find((entry) => entry.name === name);
const permanentOf = (run: Replay, name: string): EnginePermanent => {
  const found = run.ctx.state.battlefield.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} is not on the battlefield at the end`);
  return found;
};
const life = (run: Replay, seat: string): number =>
  run.state.players.find((player) => player.id === seat)!.life;
const events = (run: Replay, type: GameEvent['type']): GameEvent[] =>
  run.log.filter((event) => event.type === type);
/** The sequence at which a named step begins, so ordering claims never depend on event counts. */
function stepSequence(run: Replay, step: string, message: string): number {
  const found = events(run, 'stepBegin').find((event) => event.payload['step'] === step);
  expect(found, message).toBeDefined();
  return found!.sequence;
}
/** The permanent control record the effect left behind — how "already controlled" is observable. */
const lastGrant = (run: Replay, name: string) => permanentOf(run, name).controlChanges?.at(-1);

describe('Alicia Masters, Skilled Sculptor Card Test Lab replay', () => {
  it('pins the Oracle fixture the two published scenarios are written against', () => {
    expect(aliciaPin, `${ALICIA} must be in the pinned PR08 fixture`).toBeDefined();
    expect(aliciaPin!.sha256).toBe(
      'ec7af585cca0a36073614bba7446b7d7b2aaa339e874ced506af201a7f51c466',
    );
    expect(aliciaPin!.card.oracleId).toBe('223504ba-174a-46f2-a4a2-5d663a82dfd3');
    for (const mode of ['combat-treasure-and-owner-control', 'no-noncreature-spell'] as const) {
      const scenario = createCardTestScenario(`alicia-masters-viewer-${mode}`, 'pr08-alicia-lab');
      expect(scenario, mode).not.toBeNull();
      expect(scenario!.metadata.oracleSha256, mode).toBe(aliciaPin!.sha256);
      expect(scenario!.metadata.clauseIds, mode).toContain(
        'alicia-masters-end-step-each-player-reclaims-own-creatures',
      );
      expect(scenario!.metadata.clauseIds, mode).toContain(
        'alicia-masters-begin-combat-treasure-if-noncreature-spell-this-turn',
      );
    }
  });

  it('alicia-masters-viewer-combat-treasure-and-owner-control — a noncreature spell this turn makes one Treasure at combat, then the end step restores both stolen creatures', () => {
    const first = replay('combat-treasure-and-owner-control');
    const second = replay('combat-treasure-and-owner-control');
    // Same seed, same scripted decisions, identical event stream: every assertion below is a
    // statement about the engine rather than about one lucky run.
    expect(first.log).toEqual(second.log);
    expect(first.castOrder).toEqual(second.castOrder);
    expect(first.haltReason).toBeNull();

    // The arranged board IS the scenario, so it is asserted before anything resolves. Ownership and
    // holding are different facts and only the holding is odd.
    const opening = first.observations[0]!;
    expect(opening.entries.map((entry) => entry.name)).toEqual([
      'Mountain',
      'Mountain',
      P1_OWNED_HELD_BY_P2,
      P2_OWNED_HELD_BY_P1,
      P3_OWNED_NONCREATURE_HELD_BY_P1,
      P3_BYSTANDER,
    ]);
    expect(perm(opening, P1_OWNED_HELD_BY_P2)).toMatchObject({
      ownerId: 'P1',
      controllerId: 'P2',
    });
    expect(perm(opening, P2_OWNED_HELD_BY_P1)).toMatchObject({
      ownerId: 'P2',
      controllerId: 'P1',
      tapped: true,
    });
    expect(perm(opening, P3_OWNED_NONCREATURE_HELD_BY_P1)).toMatchObject({
      ownerId: 'P3',
      controllerId: 'P1',
    });
    expect(perm(opening, P3_BYSTANDER)).toMatchObject({ ownerId: 'P3', controllerId: 'P3' });
    expect(opening.hand).toEqual([ALICIA, WITNESS]);

    // {1}{R} was paid for, with both Mountains, through ordinary mana selection.
    expect(events(first, 'tapForMana').map((event) => event.payload['name'])).toEqual([
      'Mountain',
      'Mountain',
    ]);
    expect(events(first, 'castSpell').map((event) => event.payload)).toMatchObject([
      { player: 'P1', name: ALICIA },
      { player: 'P1', name: WITNESS },
    ]);
    expect(first.castOrder).toEqual([
      'Cast Alicia Masters, Skilled Sculptor ({1}{R})',
      'Cast Lab Priority Witness ({0})',
    ]);
    expect(first.castOrder.every((description) => !description.includes('without paying'))).toBe(
      true,
    );
    expect(
      first.state.battlefield
        .filter((entry) => entry.name === 'Mountain')
        .every((mountain) => mountain.tapped && mountain.controllerId === 'P1'),
    ).toBe(true);
    // Both spells really went through the stack and into the battlefield/graveyard.
    expect(events(first, 'zoneChange').map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: ALICIA, from: 'stack', to: 'battlefield', owner: 'P1' }),
        expect.objectContaining({ name: WITNESS, from: 'stack', to: 'graveyard', owner: 'P1' }),
      ]),
    );

    // The witness really resolved its printed effect — a cast, not a bookkeeping tally.
    expect(events(first, 'lifeGain').map((event) => event.payload)).toMatchObject([
      { player: 'P1', amount: 1, life: 21 },
    ]);
    expect(life(first, 'P1')).toBe(21);
    expect(life(first, 'P2')).toBe(40);

    // "At the beginning of combat on your turn": exactly one Treasure, sequenced strictly between
    // the beginCombat step and the declareAttackers step, and nothing before it.
    expect(events(first, 'tokenCreated')).toHaveLength(1);
    const beginCombat = stepSequence(first, 'beginCombat', 'the beginCombat step is entered');
    const declareAttackers = stepSequence(
      first,
      'declareAttackers',
      'the declareAttackers step is entered',
    );
    const token = events(first, 'tokenCreated')[0]!;
    expect(token.payload).toMatchObject({ name: TREASURE, controller: 'P1' });
    expect(token.sequence).toBeGreaterThan(beginCombat);
    expect(token.sequence).toBeLessThan(declareAttackers);
    // And no Treasure existed in any state the run was actually asked to act on until the very end.
    expect(
      first.observations.slice(0, -1).every((observation) => observation.treasures.length === 0),
    ).toBe(true);
    expect(last(first).treasures).toHaveLength(1);

    // The combat trigger is the one thing on the stack in that step, and it is the printed line.
    const triggers = events(first, 'triggerOnStack');
    expect(triggers.map((event) => event.payload['description'])).toEqual([
      COMBAT_TRIGGER,
      END_STEP_TRIGGER,
    ]);
    expect(triggers.every((event) => event.payload['source'] === ALICIA)).toBe(true);
    expect(triggers[0]!.sequence).toBeGreaterThan(beginCombat);
    expect(triggers[0]!.sequence).toBeLessThan(token.sequence);
    // Combat declared no attackers: the 0-power defenders under test can neither attack nor block.
    expect(events(first, 'attackersDeclared').map((event) => event.payload)).toMatchObject([
      { count: 0 },
    ]);

    // "Sense the Good" is queued in the END STEP, strictly after every combat step, and is the
    // only ability that resolves once the Treasure is on the battlefield.
    const ending = events(first, 'phaseBegin').find((event) => event.payload['phase'] === 'ending');
    expect(ending, 'the ending phase begins').toBeDefined();
    expect(
      first.log
        .filter((event) => event.type === 'phaseBegin')
        .map((event) => event.payload['phase']),
    ).toEqual(['combat', 'ending']);
    expect(triggers[1]!.sequence).toBeGreaterThan(ending!.sequence);
    expect(
      events(first, 'resolved')
        .map((event) => event.payload['description'])
        .slice(2),
    ).toEqual([`${ALICIA} — ${COMBAT_TRIGGER}`, `${ALICIA} — ${END_STEP_TRIGGER}`]);
    expect(events(first, 'resolved')[3]!.sequence).toBeGreaterThan(ending!.sequence);

    // Exactly one Treasure, owned and controlled by P1, and not the noncreature it resembles.
    const treasure = permanentOf(first, TREASURE);
    expect(treasure.isToken).toBe(true);
    expect(treasure.ownerId).toBe('P1');
    expect(treasure.controllerId).toBe('P1');
    expect(treasure.tapped).toBe(false);
    const treasureChars = computeCharacteristics(first.ctx, treasure);
    expect(treasureChars.types).toEqual(['Artifact']);
    expect(treasureChars.subtypes).toEqual(['Treasure']);
    expect(treasureChars.manaAbilities).toEqual([
      { units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }] },
    ]);
    // A supported mana source, not a token that merely looks like one: with both Mountains tapped
    // the Treasure is the only mana P1 can produce, through the ordinary payment solver.
    const sources = manaSourcesFor(first.ctx, 'P1');
    expect(sources.map((source) => source.cardId)).toEqual([treasure.cardId]);
    expect(sources[0]!.units).toEqual([['W', 'U', 'B', 'R', 'G']]);
    expect(sources[0]!.costs.map((cost) => cost.kind)).toEqual(['tap', 'sacrificeSelf']);

    // The end step: every living owner takes back every creature it owns.
    const final = last(first);
    expect(perm(final, P1_OWNED_HELD_BY_P2)).toMatchObject({
      ownerId: 'P1',
      controllerId: 'P1',
    });
    expect(perm(final, P2_OWNED_HELD_BY_P1)).toMatchObject({
      ownerId: 'P2',
      controllerId: 'P2',
    });
    expect(perm(final, ALICIA)).toMatchObject({ ownerId: 'P1', controllerId: 'P1' });
    expect(perm(final, P3_BYSTANDER)).toMatchObject({ ownerId: 'P3', controllerId: 'P3' });
    // A real controller transition makes a creature summoning sick again under its new controller.
    expect(permanentOf(first, P2_OWNED_HELD_BY_P1).summoningSick).toBe(true);
    expect(permanentOf(first, P1_OWNED_HELD_BY_P2).summoningSick).toBe(true);

    // "all creatures they own" is INCLUSIVE: Alicia, who P1 already controlled, and P3's bystander,
    // who P3 already controlled, each end the effect holding a fresh PERMANENT record. That record
    // is what masks any older temporary grant underneath them.
    for (const [name, owner] of [
      [ALICIA, 'P1'],
      [P3_BYSTANDER, 'P3'],
      [P2_OWNED_HELD_BY_P1, 'P2'],
      [P1_OWNED_HELD_BY_P2, 'P1'],
    ] as const) {
      expect(lastGrant(first, name), name).toMatchObject({
        controllerId: owner,
        duration: { kind: 'permanent' },
      });
      expect(lastGrant(first, name)?.timestamp ?? 0, name).toBeGreaterThan(0);
    }
    expect(
      permanentOf(first, ALICIA).summoningSick,
      'handing Alicia to P1 is not a transition',
    ).toBe(true);

    // "all CREATURES they own": P3's artifact is not a creature, so it never moves at all — no
    // control record was written for it, and it is still a noncreature afterwards.
    const relic = permanentOf(first, P3_OWNED_NONCREATURE_HELD_BY_P1);
    expect(relic.ownerId).toBe('P3');
    expect(relic.controllerId).toBe('P1');
    expect(relic.controlChanges).toBeUndefined();
    expect(computeCharacteristics(first.ctx, relic).types).not.toContain('Creature');
    // The Treasure is excluded for the same reason.
    expect(treasure.controlChanges).toBeUndefined();
    expect(perm(final, P3_OWNED_NONCREATURE_HELD_BY_P1)?.controllerId).toBe('P1');

    // The prepared run ends on its own terms: nobody lost, nothing halted.
    expect(first.state.players.every((player) => !player.hasLost)).toBe(true);
    expect(events(first, 'gameOver').map((event) => event.payload)).toMatchObject([
      { halted: false, haltReason: null },
    ]);
  });

  it('alicia-masters-viewer-no-noncreature-spell — no noncreature spell this turn means no Treasure at all, and the end step still restores both stolen creatures', () => {
    const first = replay('no-noncreature-spell');
    const second = replay('no-noncreature-spell');
    expect(first.log).toEqual(second.log);
    expect(first.castOrder).toEqual(second.castOrder);
    expect(first.haltReason).toBeNull();

    // Only a CREATURE spell went on the stack this turn. The unused witness is left castable in
    // hand, which is what makes this the negative case rather than a cast the replay skipped.
    expect(first.castOrder).toEqual(['Cast Alicia Masters, Skilled Sculptor ({1}{R})']);
    expect(events(first, 'castSpell').map((event) => event.payload)).toMatchObject([
      { player: 'P1', name: ALICIA },
    ]);
    expect(last(first).hand).toEqual([WITNESS]);
    expect(life(first, 'P1')).toBe(20);
    expect(events(first, 'lifeGain')).toHaveLength(0);
    // The fixture creatures really are 0-power defenders, so combat is combat-free and the
    // intervening if is the only thing that could have made a Treasure.
    for (const name of [P1_OWNED_HELD_BY_P2, P2_OWNED_HELD_BY_P1, P3_BYSTANDER]) {
      const chars = computeCharacteristics(first.ctx, permanentOf(first, name));
      expect(chars.power, name).toBe(0);
      expect(chars.keywords, name).toContain('defender');
    }

    // The intervening if is false, so the combat trigger is NEVER put on the stack: the one
    // trigger in the whole run is the unconditional end-step one.
    expect(events(first, 'tokenCreated')).toHaveLength(0);
    expect(events(first, 'triggerOnStack').map((event) => event.payload['description'])).toEqual([
      END_STEP_TRIGGER,
    ]);
    // The one trigger that did fire is the end-step one, and it fired in the END STEP — not at the
    // beginning of combat, where the intervening if would have queued the other one.
    const beginCombat = stepSequence(first, 'beginCombat', 'combat is still entered');
    expect(events(first, 'triggerOnStack')[0]!.sequence).toBeGreaterThan(beginCombat);
    expect(
      events(first, 'phaseBegin').find((event) => event.payload['phase'] === 'ending'),
      'the ending phase begins',
    ).toBeDefined();
    expect(events(first, 'resolved').map((event) => event.payload['description'])).toEqual([
      ALICIA,
      `${ALICIA} — ${END_STEP_TRIGGER}`,
    ]);
    expect(
      first.log
        .filter((event) => event.type === 'phaseBegin')
        .map((event) => event.payload['phase']),
    ).toEqual(['combat', 'ending']);

    // No Treasure in any zone and in no state the run was asked to act on.
    expect(first.observations.every((observation) => observation.treasures.length === 0)).toBe(
      true,
    );
    expect(first.state.battlefield.some((entry) => entry.name === TREASURE)).toBe(false);
    expect(first.state.exile.some((card) => card.name === TREASURE)).toBe(false);
    expect(
      first.state.players.some((player) =>
        [...player.hand, ...player.graveyard, ...player.commandZone, ...player.library].some(
          (card) => card.name === TREASURE,
        ),
      ),
    ).toBe(false);
    // With no Treasure, both Mountains being tapped leaves P1 with no mana source at all.
    expect(manaSourcesFor(first.ctx, 'P1')).toHaveLength(0);

    // "Sense the Good" carries no condition, so the restoration happens exactly as before — and
    // here the run pauses for input inside the end step, which is where the timing is visible: the
    // decision is still taken while both stolen creatures are held by the wrong players, and the
    // trigger on the stack at that moment is the end-step ability that then resolves them.
    const pausedInEndStep = first.observations.filter(
      (observation) => observation.phase === 'ending' && observation.step === 'end',
    );
    expect(
      pausedInEndStep.some(
        (observation) =>
          perm(observation, P1_OWNED_HELD_BY_P2)?.controllerId === 'P2' &&
          perm(observation, P2_OWNED_HELD_BY_P1)?.controllerId === 'P1',
      ),
      'the stolen creatures are still stolen while the end-step trigger waits on the stack',
    ).toBe(true);
    expect(
      first.observations.some(
        (observation) => observation.phase === 'combat' && observation.treasures.length > 0,
      ),
    ).toBe(false);
    expect(
      first.observations.some(
        (observation) =>
          observation.phase === 'combat' &&
          perm(observation, P1_OWNED_HELD_BY_P2)?.controllerId === 'P1',
      ),
      'combat never restored control',
    ).toBe(false);

    const final = last(first);
    expect(perm(final, P1_OWNED_HELD_BY_P2)).toMatchObject({
      ownerId: 'P1',
      controllerId: 'P1',
    });
    expect(perm(final, P2_OWNED_HELD_BY_P1)).toMatchObject({
      ownerId: 'P2',
      controllerId: 'P2',
    });
    expect(perm(final, ALICIA)).toMatchObject({ ownerId: 'P1', controllerId: 'P1' });
    expect(perm(final, P3_BYSTANDER)).toMatchObject({ ownerId: 'P3', controllerId: 'P3' });
    expect(perm(final, P3_OWNED_NONCREATURE_HELD_BY_P1)?.controllerId).toBe('P1');
    expect(permanentOf(first, P3_OWNED_NONCREATURE_HELD_BY_P1).controlChanges).toBeUndefined();
    expect(lastGrant(first, ALICIA)).toMatchObject({
      controllerId: 'P1',
      duration: { kind: 'permanent' },
    });
    expect(lastGrant(first, P3_BYSTANDER)).toMatchObject({
      controllerId: 'P3',
      duration: { kind: 'permanent' },
    });
    expect(first.state.players.every((player) => !player.hasLost)).toBe(true);
  });
});
