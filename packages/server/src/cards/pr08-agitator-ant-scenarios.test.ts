/**
 * PR08.13: Agitator Ant — Card Test Lab replay.
 *
 * Both registered scenarios run the printed {2}{R} creature through the production engine: a real
 * cast chosen from the ordinary legal-action menu, the ordinary mana solver tapping a Mountain and
 * two Forests, the real stack, real priority passes, P1's real end step, the real cleanup step and
 * P2's real turn. Nothing here arranges an outcome — the assertions read the authoritative engine
 * state and the complete event stream after replaying the scenario, and the only difference the
 * two runs are allowed to have is the one the card's own text allows: whether a player puts the
 * counters on or declines.
 *
 * What the accept replay pins:
 *
 *  - The cast is the printed one. It has NO targets, so it has no target slots and neither does any
 *    of the three choice menus: "a creature they control" is a resolution choice, not a target, so
 *    hexproof or shroud could never exclude anything.
 *  - The trigger waits for P1's end step. It is queued as an ordinary waiting trigger and reached
 *    through the ordinary "Yield to this ability" priority action.
 *  - Three players are asked, in APNAP order from the ACTIVE player P1, and P4 is never asked at
 *    all because it controls no creature. Every menu names only that player's OWN creatures.
 *  - While ANY of the three menus is still open, no counter has moved and no goad exists
 *    (CR 608.2d): the board is snapshotted at every menu, not reconstructed afterwards.
 *  - Each choice is published as it is made, with its chooser as the actor, and P3's decline is
 *    published as a decline with no object.
 *  - Two placements and two goads, and nothing for P3: exactly one `counters` record per surviving
 *    placement, and the goad is bound by the ability's CONTROLLER (P1) even on P2's own Bear.
 *  - The cleanup step does not end a goad (CR 701.15a), so the goad is still on P2's Bear when P2
 *    declares attackers, and that Bear then attacks P3 rather than P1.
 *
 * What the decline replay pins: three menus, three declines, no `counters` record, no `goad`
 * record, a 2/2 Agitator Ant, an untouched P2 and P3, and no Ant trigger at all on P2's end step.
 *
 * Finally the goad's duration is proven on a real Engine too: the same published decks and the same
 * arranged board, continued through four further turn beginnings instead of P2's combat, which
 * reaches P1's NEXT untap — where the goad ends — and stops before a second Ant end step. That
 * continuation cannot be a flag on the published scenario, because a prepared run offers exactly
 * one continuation and the published scenario's is P2's turn.
 */
import { readFileSync } from 'node:fs';
import { Engine, interpretCard } from '@mtg/engine';
import type { DecisionRequest, GameEvent, GameId, OracleCard } from '@mtg/shared';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { GameContext } from '../../../engine/src/state/types';
import { createCardTestScenario } from './card-test-scenarios';
import type { CardTestScenario } from './card-test-scenarios';

type Mode = 'accept' | 'decline';

const ANT = 'Agitator Ant';
const WITNESS = 'Lab Ant Priority Witness';
const P2_BEAR = 'Lab Ant Bear';
const P3_CUB = 'Lab Ant Cub';
const ORACLE_ID = 'abe377f8-35f0-4dea-a681-91d31a36815c';
/** The exact `sha256` recorded in the committed `coverage-pr08-oracle.json` fixture. */
const ORACLE_SHA256 = '02655069d32bb3566e265f4d4ee06a65e89067c753c393dcb57eca89f7cbb53a';
const CLAUSES = ['agitator-ant-end-step-counter-choice', 'agitator-ant-goad-positive-placements'];
/** The tail of the asking stack entry's prompt, which every player of the choice set sees. */
const ASK = 'put 2 +1/+1 counters on a creature you control, or put none.';
const DECLINE = 'Put no counters';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
const antPin = pins.find((entry) => entry.card.name === ANT);

interface Menu {
  decidingPlayer: string;
  prompt: string;
  descriptions: string[];
  /** Target slots on every option: these choices are not targets, so this must always be empty. */
  slots: number[];
  /** The board exactly as it stood while this menu was open (CR 608.2d). */
  counters: Array<[string, number]>;
  goaded: string[];
}

interface Observation {
  turn: number;
  currentTurnPlayer: string;
  phase: string;
  step: string | null;
  stackDescriptions: string[];
  life: number[];
  counters: Array<[string, number]>;
  /** Effective printed-plus-counter statistics of every creature on the board, read live. */
  stats: Array<[string, number, number]>;
  goaded: string[];
}

type Replay = ReturnType<typeof replay>;

function ctxOf(engine: Engine): GameContext {
  return (engine as unknown as { ctx: GameContext }).ctx;
}

/** Read the AUTHORITATIVE engine state, never the published projection: `getState()` is the wire
 * shape and deliberately carries neither a goad nor the turn's active player. */
function boardCounters(state: GameContext['state']): Array<[string, number]> {
  return state.battlefield.map((permanent) => [permanent.name, permanent.counters['+1/+1'] ?? 0]);
}

function boardGoads(state: GameContext['state']): string[] {
  return state.battlefield
    .filter((permanent) => (permanent.goadedBy ?? []).length > 0)
    .map((permanent) => permanent.name)
    .sort();
}

function boardStats(ctx: GameContext): Array<[string, number, number]> {
  return ctx.state.battlefield.flatMap((permanent) => {
    const chars = computeCharacteristics(ctx, permanent);
    return chars.types.includes('Creature')
      ? ([[permanent.name, chars.power, chars.toughness]] as Array<[string, number, number]>)
      : [];
  });
}

/** Whether this surfaced request is the Ant's per-player counter choice. */
function isAntMenu(request: DecisionRequest): boolean {
  return request.legalActions.some((action) =>
    action.description.startsWith('Put 2 +1/+1 counters on '),
  );
}

/**
 * P1's own answers: cast the printed {2}{R} creature once, then answer the Ant's menu with the
 * creature this run is about, and otherwise pass. Block declarations are answered with the
 * engine's own "no block" choice, which is what the viewer's "Confirm blocks" sends.
 */
function casterSeat(mode: Mode) {
  let cast = false;
  return (request: DecisionRequest) => {
    if (!cast) {
      const spell = request.legalActions.find((action) =>
        action.description.startsWith(`Cast ${ANT} `),
      );
      if (spell !== undefined) {
        cast = true;
        return { requestId: request.requestId, actionId: spell.id };
      }
    }
    if (isAntMenu(request)) {
      const wanted = mode === 'accept' ? `Put 2 +1/+1 counters on ${ANT}` : DECLINE;
      const action = request.legalActions.find((entry) => entry.description === wanted);
      if (action === undefined)
        throw new Error(`No "${wanted}" on the Ant menu for ${request.decidingPlayer}`);
      return { requestId: request.requestId, actionId: action.id };
    }
    const blocks = request.legalActions.find((action) => action.type === 'blockDeclaration');
    if (blocks !== undefined) {
      return {
        requestId: request.requestId,
        actionId: blocks.id,
        targets: (blocks.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.includes(NO_BLOCK_TARGET)
            ? NO_BLOCK_TARGET
            : (slot.options[0] as string),
        })),
      };
    }
    const pass = request.legalActions.find((action) => action.type === 'pass');
    return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
  };
}

/**
 * Replay one registered scenario end to end. The seats the scenario scripts answer exactly as the
 * real Card Test Lab session answers them, through the published `decisionProviderOverrides`.
 */
function replay(mode: Mode) {
  return drive(
    createCardTestScenario(`agitator-ant-viewer-${mode}`, 'pr08-ant-lab'),
    casterSeat(mode),
  );
}

function drive(
  scenario: CardTestScenario | null,
  caster: (request: DecisionRequest) => { requestId: string; actionId: number; targets?: unknown },
) {
  expect(scenario, 'the Agitator Ant scenario').not.toBeNull();
  const engine = scenario!.engine;
  const ctx = ctxOf(engine);
  const observations: Observation[] = [];
  const menus: Menu[] = [];
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    observations.push({
      turn: ctx.state.turnNumber,
      currentTurnPlayer: ctx.state.currentTurnPlayer,
      phase: ctx.state.phase,
      step: ctx.state.step,
      stackDescriptions: ctx.state.stack.map((entry) => entry.description),
      life: ctx.state.players.map((player) => player.life),
      counters: boardCounters(ctx.state),
      stats: boardStats(ctx),
      goaded: boardGoads(ctx.state),
    });
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 80) throw new Error(`Agitator Ant ${scenario!.metadata.id} did not finish`);
    const request = step.request;
    // The board is read at the moment each menu is asked, so "no counter has moved yet" and "the
    // menu names only my own creatures" are observations rather than reconstructions.
    if (isAntMenu(request)) {
      menus.push({
        decidingPlayer: request.decidingPlayer,
        prompt: request.prompt ?? '',
        descriptions: request.legalActions.map((action) => action.description),
        slots: request.legalActions.flatMap((action) => (action.targets ?? []).map((s) => s.slot)),
        counters: boardCounters(ctx.state),
        goaded: boardGoads(ctx.state),
      });
    }
    const override = scenario!.decisionProviderOverrides?.[request.decidingPlayer];
    engine.submit(override !== undefined ? override.decide(request) : (caster(request) as never));
  }
  return {
    scenario: scenario!,
    ctx,
    state: ctx.state,
    log: ctx.state.eventLog,
    observations,
    menus,
    haltReason: engine.getResult()?.haltReason ?? null,
  };
}

const events = (run: Replay, type: GameEvent['type']): GameEvent[] =>
  run.log.filter((event) => event.type === type);
const last = (run: Replay): Observation => run.observations.at(-1)!;
const life = (run: Replay, seat: string): number =>
  run.ctx.state.players.find((player) => player.id === seat)!.life;
const permanent = (run: Replay, name: string) => {
  const found = run.ctx.state.battlefield.filter((entry) => entry.name === name);
  expect(found.length, `${name} permanents on the battlefield`).toBe(1);
  return found[0]!;
};
const goaders = (run: Replay, name: string): string[] =>
  (permanent(run, name).goadedBy ?? []).map((entry) => entry.goaderId);

describe('Agitator Ant Card Test Lab replay', () => {
  it('pins the Oracle fixture, the published clause mapping and the two prepared boards', () => {
    expect(antPin, `${ANT} must be in the pinned PR08 fixture`).toBeDefined();
    expect(antPin!.sha256).toBe(ORACLE_SHA256);
    expect(antPin!.card.oracleId).toBe(ORACLE_ID);
    expect(antPin!.card.manaCost).toBe('{2}{R}');
    expect(antPin!.card.types).toEqual(['Creature']);
    expect(antPin!.card.subtypes).toEqual(['Insect']);
    expect([antPin!.card.power, antPin!.card.toughness]).toEqual(['2', '2']);
    // A modeled claim has to survive the same interpreter the coverage gate uses.
    const def = interpretCard(antPin!.card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.spellAbility).toBeNull();
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]).toMatchObject({ trigger: { when: 'endStep', player: 'you' } });

    const titles: Record<Mode, string> = {
      accept: 'Agitator Ant: accepting counters goads the chosen creatures',
      decline: 'Agitator Ant: declining counters leaves its creature ungoaded',
    };
    for (const mode of ['accept', 'decline'] as const) {
      const scenario = createCardTestScenario(`agitator-ant-viewer-${mode}`, 'pr08-ant-pin');
      expect(scenario, mode).not.toBeNull();
      // Both clause IDs ride on BOTH scenarios: each run resolves the whole printed clause, so
      // neither is allowed to be scoped to a single run.
      expect(scenario!.metadata.clauseIds, mode).toEqual(CLAUSES);
      expect(scenario!.metadata.oracleSha256, mode).toBe(ORACLE_SHA256);
      expect(scenario!.metadata.title, mode).toBe(titles[mode]);
    }
  });

  it('agitator-ant-viewer-accept — accepting goads the Ant and P2’s own Bear, and P2 attacks P3', () => {
    const first = replay('accept');
    const second = replay('accept');
    // Same seed, same scripted seats, identical event stream: every claim below is about the
    // engine rather than about one lucky run.
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.haltReason).toBeNull();

    // The arranged board IS the scenario. Every fixture is a printed creature with real
    // characteristics — never a `noOp` placeholder wearing a name.
    const opening = first.observations[0]!;
    expect(opening.counters.map(([name]) => name)).toEqual([
      'Mountain',
      'Forest',
      'Forest',
      P2_BEAR,
      P3_CUB,
    ]);
    expect(opening.life).toEqual([40, 40, 40, 40]);
    expect(opening.goaded).toEqual([]);
    // Both bystanders are ordinary printed 2/2 Bears: the counters below move them off 2/2, so a
    // fixture that started at some other number could not be read as the card's doing.
    expect(opening.stats).toEqual([
      [P2_BEAR, 2, 2],
      [P3_CUB, 2, 2],
    ]);
    for (const name of [P2_BEAR, P3_CUB]) {
      const chars = computeCharacteristics(first.ctx, permanent(first, name));
      expect(chars.types, name).toEqual(['Creature']);
      expect(chars.subtypes, name).toEqual(['Bear']);
    }
    // P4 controls no creature at all: it is never asked, and it has nothing on the board.

    // {2}{R} was paid for with exactly the Mountain and the two Forests, through ordinary mana
    // selection, and the spell has no targets at all.
    expect(
      first.log.filter((event) => event.type === 'castSpell').map((e) => e.payload),
    ).toMatchObject([
      // `targets: []` on the authoritative cast is the proof the printed spell targets nothing.
      { player: 'P1', name: ANT, targets: [] },
    ]);
    expect(events(first, 'tapForMana').map((event) => event.payload['name'])).toEqual([
      'Mountain',
      'Forest',
      'Forest',
    ]);
    expect(
      first.state.battlefield
        .filter((entry) => entry.name === 'Forest' || entry.name === 'Mountain')
        .every((land) => land.tapped && land.controllerId === 'P1'),
    ).toBe(true);
    // The creature really entered: a 2/2 with neither counters nor goad of its own.
    const entered = first.log.findIndex(
      (event) => event.type === 'castSpell' && event.payload['name'] === ANT,
    );
    expect(entered).toBeGreaterThanOrEqual(0);

    // Exactly three menus, in APNAP order from the ACTIVE player P1, and P4 is never asked.
    expect(first.menus.map((menu) => menu.decidingPlayer)).toEqual(['P1', 'P2', 'P3']);
    expect(first.menus.every((menu) => menu.prompt.startsWith(ANT))).toBe(true);
    expect(first.menus.every((menu) => menu.prompt.endsWith(ASK))).toBe(true);
    expect(first.menus.map((menu) => menu.descriptions)).toEqual([
      [`Put 2 +1/+1 counters on ${ANT}`, DECLINE],
      [`Put 2 +1/+1 counters on ${P2_BEAR}`, DECLINE],
      [`Put 2 +1/+1 counters on ${P3_CUB}`, DECLINE],
    ]);
    for (const menu of first.menus) {
      // A resolution choice, never a target: no slot anywhere, so nothing can exclude a chooser.
      expect(menu.slots, menu.decidingPlayer).toEqual([]);
      // And each player is offered only the creatures THEY control.
      const own = menu.descriptions.filter((entry) => entry !== DECLINE);
      expect(own.length, menu.decidingPlayer).toBe(1);
    }
    // No counter and no goad exists while ANY of the three menus is still open (CR 608.2d).
    for (const menu of first.menus) {
      expect(menu.counters, menu.decidingPlayer).toEqual([
        ['Mountain', 0],
        ['Forest', 0],
        ['Forest', 0],
        [P2_BEAR, 0],
        [P3_CUB, 0],
        [ANT, 0],
      ]);
      expect(menu.goaded, menu.decidingPlayer).toEqual([]);
    }

    // Each choice is public as it is made, with the chooser as the actor, and P3's decline is
    // published as a decline with no object behind it.
    const choices = events(first, 'permanentChoice');
    expect(choices.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3']);
    expect(choices.map((event) => event.payload['name'] ?? null)).toEqual([ANT, P2_BEAR, null]);
    expect(choices.every((event) => String(event.payload['source']).startsWith(ANT))).toBe(true);

    // Two placements and two goads — and nothing at all for P3, whose decline is not a placement.
    const counters = events(first, 'counters').map((event) => event.payload);
    expect(counters.map((entry) => [entry['target'], entry['added'], entry['total']])).toEqual([
      [ANT, 2, 2],
      [P2_BEAR, 2, 2],
    ]);
    expect(events(first, 'goad').map((event) => event.payload['target'])).toEqual([ANT, P2_BEAR]);
    expect(goaders(first, ANT)).toEqual(['P1']);
    expect(goaders(first, P2_BEAR)).toEqual(['P1']);
    // The goad is bound by the ability's controller, never by the chooser.
    expect(permanent(first, ANT).goadedBy).toEqual([{ goaderId: 'P1', appliedTurn: 1 }]);
    expect(permanent(first, P2_BEAR).goadedBy).toEqual([{ goaderId: 'P1', appliedTurn: 1 }]);
    // P3's own creature is exactly where the arrangement left it.
    expect(permanent(first, P3_CUB).counters['+1/+1'] ?? 0).toBe(0);
    expect(permanent(first, P3_CUB).goadedBy).toBeUndefined();

    // Both chosen creatures really became 4/4 through layer 7c, not through a rewritten stat.
    for (const name of [ANT, P2_BEAR]) {
      const chars = computeCharacteristics(first.ctx, permanent(first, name));
      expect([chars.power, chars.toughness], name).toEqual([4, 4]);
    }
    expect(computeCharacteristics(first.ctx, permanent(first, P3_CUB)).power, P3_CUB).toBe(2);

    // The cleanup step ran BETWEEN the goad and P2's attack, and the goad was still on the Bear:
    // a goad lasts until its goader's next turn (CR 701.15a), not until end of turn.
    const goadSequence = events(first, 'goad').at(-1)!.sequence;
    const cleanup = first.log.find(
      (event) => event.type === 'stepBegin' && event.payload['step'] === 'cleanup',
    );
    expect(cleanup, 'a real cleanup step ran').toBeDefined();
    expect(cleanup!.sequence).toBeGreaterThan(goadSequence);
    const attack = events(first, 'attack');
    expect(attack).toHaveLength(1);
    expect(attack[0]!.sequence).toBeGreaterThan(cleanup!.sequence);
    expect(attack[0]!.payload).toMatchObject({ attacker: P2_BEAR, defender: 'P3' });
    expect(events(first, 'attackersDeclared').map((event) => event.payload['count'])).toEqual([
      0, 1,
    ]);
    // P3 took the 4 damage and P1 took none: the goad really kept its own goader out.
    expect(life(first, 'P3')).toBe(36);
    expect(life(first, 'P1')).toBe(40);
    expect(life(first, 'P2')).toBe(40);
    expect(life(first, 'P4')).toBe(40);
    expect(first.state.players.every((player) => !player.hasLost)).toBe(true);

    // The Ant triggered once, on P1's end step. The run went on through P2's OWN end step, which
    // is not "your end step", and produced no second resolution.
    const resolutions = first.log.filter(
      (event) =>
        event.type === 'resolved' &&
        typeof event.payload['description'] === 'string' &&
        event.payload['description'].startsWith(`${ANT} — `),
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.actorSeat).toBe('P1');
    expect(resolutions[0]!.sequence).toBeLessThan(cleanup!.sequence);
    const final = last(first);
    expect(final.currentTurnPlayer).toBe('P2');
    expect(final.turn).toBe(2);
    // The counters and the goad both outlived the run: nothing was undone after the combat.
    expect(final.goaded).toEqual([ANT, P2_BEAR].sort());

    // The viewer projection this run would publish keeps every opponent's hidden cards hidden.
    const projection = first.scenario.engine.playerState('P1');
    expect(projection.viewerSeat).toBe('P1');
    const serialized = JSON.stringify(projection);
    for (const player of first.state.players.filter((entry) => entry.id !== 'P1')) {
      const seat = projection.seats.find((entry) => entry.seat === player.id)!;
      expect(seat.hand, `${player.id} hand is withheld`).toBeNull();
      expect(seat.handSize).toBe(player.hand.length);
      for (const card of [...player.hand, ...player.library]) {
        expect(serialized, `${player.id} never publishes ${card.name}`).not.toContain(card.id);
      }
    }
    // The published board carries the counters as effective statistics, and never a goad field:
    // the goad's only public proof here is the attack it forced.
    const published = projection.battlefield;
    expect(published.filter((entry) => entry.name === P2_BEAR).map((entry) => entry.power)).toEqual(
      [4],
    );
    expect(published.some((entry) => Object.keys(entry).some((key) => key.includes('goad')))).toBe(
      false,
    );
  });

  it('agitator-ant-viewer-decline — declining leaves the Ant a plain 2/2 and nothing goaded', () => {
    const first = replay('decline');
    const second = replay('decline');
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.haltReason).toBeNull();

    // The same three players are asked on the same board — the printed instruction is optional
    // per player, and a player with no creature is never asked at all.
    expect(first.menus.map((menu) => menu.decidingPlayer)).toEqual(['P1', 'P2', 'P3']);
    expect(first.menus.map((menu) => menu.descriptions)).toEqual([
      [`Put 2 +1/+1 counters on ${ANT}`, DECLINE],
      [`Put 2 +1/+1 counters on ${P2_BEAR}`, DECLINE],
      [`Put 2 +1/+1 counters on ${P3_CUB}`, DECLINE],
    ]);
    for (const menu of first.menus) expect(menu.slots, menu.decidingPlayer).toEqual([]);
    expect(
      first.menus.map((menu) => menu.decidingPlayer),
      'P4 controls no creature and is never prompted',
    ).not.toContain('P4');

    // Every decline is still public, with no object behind it.
    const choices = events(first, 'permanentChoice');
    expect(choices.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3']);
    expect(
      choices.every(
        (event) => event.payload['name'] === null && event.payload['objectId'] === null,
      ),
    ).toBe(true);

    // Nothing was placed and nothing was goaded — not even for the Ant's own chooser.
    expect(events(first, 'counters')).toEqual([]);
    expect(events(first, 'goad')).toEqual([]);
    expect(permanent(first, ANT).counters['+1/+1'] ?? 0).toBe(0);
    expect(permanent(first, ANT).goadedBy).toBeUndefined();
    expect(computeCharacteristics(first.ctx, permanent(first, ANT))).toMatchObject({
      power: 2,
      toughness: 2,
    });
    for (const name of [P2_BEAR, P3_CUB]) {
      expect(permanent(first, name).counters['+1/+1'] ?? 0, name).toBe(0);
      expect(permanent(first, name).goadedBy, name).toBeUndefined();
    }
    expect(boardGoads(first.state)).toEqual([]);

    // Nothing attacked and nobody lost life: an un-goaded Bear may legally stay home, and the
    // scripted seat does exactly that.
    expect(events(first, 'attack')).toEqual([]);
    expect(events(first, 'attackersDeclared').map((event) => event.payload['count'])).toEqual([
      0, 0,
    ]);
    expect(first.state.players.map((player) => player.life)).toEqual([40, 40, 40, 40]);

    // P2's own end step is not "your end step": the Ant resolved exactly once in the whole run.
    const resolutions = first.log.filter(
      (event) =>
        event.type === 'resolved' &&
        typeof event.payload['description'] === 'string' &&
        event.payload['description'].startsWith(`${ANT} — `),
    );
    expect(resolutions).toHaveLength(1);
    expect(last(first).currentTurnPlayer).toBe('P2');
    expect(last(first).turn).toBe(2);
    // The unused witness is still castable in the very window the run ended in.
    expect(first.scenario.metadata.clauseIds).toEqual(CLAUSES);
  });
});

/**
 * The goad's duration on a real Engine: the same published decks and the same arranged board,
 * continued through four further turn beginnings rather than P2's combat. That reaches P1's NEXT
 * untap — where a goad ends (CR 701.15a) — and stops before a second Agitator Ant end step. A
 * prepared run offers exactly one continuation, so this cannot be a flag on the published
 * scenario; the board below is the published arrangement, restated rather than mutated.
 */
describe('Agitator Ant goad expiry continuation', () => {
  it('agitator-ant-goad-expires-at-the-goaders-next-untap — P1’s next untap ends it, and the run stops before another Ant end step', () => {
    const published = createCardTestScenario('agitator-ant-viewer-accept', 'pr08-ant-expiry');
    expect(published).not.toBeNull();
    const engine = new Engine(
      {
        gameId: 'pr08-ant-expiry' as GameId,
        seed: published!.seed,
        players: published!.seats.map((seat) => seat.config),
        turnCap: 2,
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          lifeTotals: [
            { playerId: 'P1', life: 40 },
            { playerId: 'P2', life: 40 },
            { playerId: 'P3', life: 40 },
            { playerId: 'P4', life: 40 },
          ],
          hand: [{ playerId: 'P1', cardNames: [ANT, WITNESS] }],
          battlefield: [
            { playerId: 'P1', cardNames: ['Mountain', 'Forest', 'Forest'] },
            { playerId: 'P2', cardNames: [P2_BEAR] },
            { playerId: 'P3', cardNames: [P3_CUB] },
          ],
          // No `continueToEndStep` here: the first ending phase below IS P1's end step, and asking
          // for it twice would resolve the Ant's trigger twice on the same turn.
          continueThroughPrecombatMains: 4,
        },
      },
    );
    const run = drive({ ...published!, engine }, casterSeat('accept'));
    expect(run.haltReason).toBeNull();

    // The goad really was applied on P1's end step, before the run moved on.
    const goadSequence = events(run, 'goad').map((event) => event.sequence);
    expect(goadSequence).toHaveLength(2);
    // Four further turn beginnings later the run is on P1 again, and P1's untap has stripped both.
    const final = last(run);
    expect(final.currentTurnPlayer).toBe('P1');
    expect(final.turn).toBeGreaterThan(4);
    expect(final.goaded).toEqual([]);
    expect(permanent(run, ANT).goadedBy).toBeUndefined();
    expect(permanent(run, P2_BEAR).goadedBy).toBeUndefined();
    // The counters are a real permanent fact and are untouched by the goad ending.
    expect(permanent(run, ANT).counters['+1/+1'] ?? 0).toBe(2);
    expect(permanent(run, P2_BEAR).counters['+1/+1'] ?? 0).toBe(2);
    expect(
      permanent(run, P2_BEAR).counterTimestamps?.['+1/+1'] ?? 0,
      'the counters were really placed',
    ).toBeGreaterThan(0);

    // The goads ended at P1's next untap, not earlier: they were still there on P2's, P3's and
    // P4's beginnings, and gone from P1's.
    const untaps = run.log.filter(
      (event) => event.type === 'stepBegin' && event.payload['step'] === 'upkeep',
    );
    expect(untaps.length).toBeGreaterThanOrEqual(4);
    const goadStillOn = run.observations.filter((observation) => observation.goaded.length > 0);
    expect(goadStillOn.at(-1)!.currentTurnPlayer).not.toBe('P1');
    expect(goadStillOn.at(-1)!.turn).toBeLessThan(final.turn);

    // And it stopped before a second Agitator Ant end step: exactly one resolution ever happened.
    const resolutions = run.log.filter(
      (event) =>
        event.type === 'resolved' &&
        typeof event.payload['description'] === 'string' &&
        event.payload['description'].startsWith(`${ANT} — `),
    );
    expect(resolutions).toHaveLength(1);
    expect(events(run, 'counters')).toHaveLength(2);
  });
});
