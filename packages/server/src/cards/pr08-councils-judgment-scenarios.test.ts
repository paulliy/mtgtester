/**
 * PR08.15: Council's Judgment — Card Test Lab replay.
 *
 * Both scenarios run the printed {1}{W}{W} sorcery through the production engine: real legality,
 * the ordinary payment solver choosing the three Plains, the real stack, real priority passes, real
 * resolution, and the real per-player vote the ability asks for. Nothing here arranges an outcome —
 * the assertions read the authoritative engine state, the complete event stream and the published
 * projections after replaying the scenario through `advance()`/`submit()`, and the only difference
 * the two runs are allowed to have is how the four votes land.
 *
 * What the replay pins:
 *
 *  - {1}{W}{W} was paid for with exactly three Plains, through ordinary mana selection: three
 *    `tapForMana` events and one `castSpell` for P1, followed by a real zone change off the stack
 *    into the graveyard. A sorcery is never a battlefield permanent.
 *  - The spell has NO targets. There are no target slots on the cast action and none on any vote
 *    option, which is what makes a vote a resolution choice rather than a target — and why an
 *    opponent's hexproof could never remove one.
 *  - "Starting with you" is literal: the rotation starts at the ABILITY CONTROLLER's own turn
 *    slot, so P1 is asked first, and every living player is asked exactly once.
 *  - Nobody may abstain. Each menu is exactly the three opponent nonland permanents, with no
 *    "none"/"skip" entry, and the caster's own nonland permanent and every land on the table are
 *    absent from all four menus.
 *  - Every vote is PUBLIC before anything leaves: four `vote` events naming source, voter and the
 *    exact object, every one of them after the cast and every one of them before the first exile.
 *  - "the most votes OR TIED FOR MOST votes" then exiles every positive highest-vote winner
 *    together: two in the 2:2:0 run, one in the 4:0:0 run. A zero-vote permanent is never exiled,
 *    so the unvoted Gamma survives the tie.
 *
 * The board is arranged with printed artifacts and one printed 0/3 with `Defender` and `Hexproof`,
 * so "a nonland permanent you don't control" is read against real characteristics rather than a
 * name. No blank spell, no force-declared `modeled: true`, no `noOp` stand-in appears anywhere: the
 * only other card in P1's hand is a real {0} instant with a printed, resolvable effect, and it is
 * never cast, so the run stops in the priority window the spell resolved in.
 */
import { readFileSync } from 'node:fs';
import { formatPlayerLog, interpretCard } from '@mtg/engine';
import type { DecisionRequest, GameEvent, OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { GameContext } from '../../../engine/src/state/types';
import { createCardTestScenario } from './card-test-scenarios';

type Mode = 'tied-votes' | 'unanimous-hexproof';

const COUNCIL = "Council's Judgment";
const WITNESS = 'Lab Priority Witness';
const ALPHA = 'Lab Council Alpha';
const BETA = 'Lab Council Beta';
const GAMMA = 'Lab Council Gamma';
const OWN_RELIC = 'Lab Council Relic';
const SENTINEL = 'Lab Council Warded Sentinel';
const VOTE_PROMPT = `${COUNCIL}: vote for a permanent P1 doesn't control.`;
const ORACLE_SHA256 = 'fc8ad609d7a659cefbc858742af30f585db3edc89eca1de03dec248a1e8eb0a1';
const TITLES: Record<Mode, string> = {
  'tied-votes': `${COUNCIL}: tied votes exile both winners and spare the unvoted permanent`,
  'unanimous-hexproof': `${COUNCIL}: unanimous votes exile a creature with hexproof`,
};

/** The exact witness object the prepared board puts in P1's hand, for the "no blank card" claim. */
const WITNESS_ORACLE: OracleCard = {
  oracleId: 'lab-pr08-priority-witness',
  scryfallId: 'lab-lab-pr08-priority-witness',
  name: WITNESS,
  manaCost: '{0}',
  cmc: 0,
  colors: [],
  colorIdentity: [],
  typeLine: 'Instant',
  supertypes: [],
  types: ['Instant'],
  subtypes: [],
  oracleText: 'You gain 1 life.',
  power: null,
  toughness: null,
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
};

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
const councilPin = pins.find((entry) => entry.card.name === COUNCIL);

/** What each seat votes for. This is a PLAN the replay answers, never an outcome it forces. */
const PLANNED_VOTES: Record<Mode, Record<PlayerId, string>> = {
  'tied-votes': { P1: ALPHA, P2: ALPHA, P3: BETA, P4: BETA },
  'unanimous-hexproof': { P1: SENTINEL, P2: SENTINEL, P3: SENTINEL, P4: SENTINEL },
};

interface BoardEntry {
  name: string;
  controllerId: string;
  ownerId: string;
  tapped: boolean;
}

interface Observation {
  phase: string;
  step: string | null;
  stackSize: number;
  stackDescriptions: string[];
  life: number[];
  entries: BoardEntry[];
  hand: string[];
  graveyard: string[];
}

interface PermanentCharacteristics {
  types: string[];
  power: number | null;
  toughness: number | null;
  keywords: string[];
}

interface VoteMenu {
  prompt: string;
  decidingPlayer: string;
  descriptions: string[];
  /** Per option: how many target slots it carried, so a vote would have been a target. */
  optionTargetSlotCounts: number[];
  /** Read at the moment the question was asked, so "nothing left yet" is an observation. */
  exiledBefore: number;
  votesBefore: number;
  battlefieldBefore: string[];
}

type Replay = ReturnType<typeof replay>;

/** The council's own menu: a general decision whose prompt is the printed vote instruction. */
function isVoteMenu(request: DecisionRequest): boolean {
  return request.prompt === VOTE_PROMPT;
}

const exileEvents = (ctx: GameContext): GameEvent[] =>
  ctx.state.eventLog.filter(
    (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
  );
const voteEvents = (ctx: GameContext): GameEvent[] =>
  ctx.state.eventLog.filter((event) => event.type === 'vote');

function replay(mode: Mode) {
  const scenario = createCardTestScenario(`councils-judgment-viewer-${mode}`, 'pr08-council-lab');
  expect(scenario, `scenario councils-judgment-viewer-${mode}`).not.toBeNull();
  const engine = scenario!.engine;
  const observations: Observation[] = [];
  const menus: VoteMenu[] = [];
  const castOrder: string[] = [];
  // Object ids are engine-side facts rather than part of the published projection, so they are read
  // from the authoritative context and captured as the board was ARRANGED — the exiled objects are
  // gone by the time the assertions run.
  const ctx = (engine as unknown as { ctx: GameContext }).ctx;
  const openingIds = new Map<string, string[]>();
  // Characteristics are read while the permanent is still in play: computing them for an exiled
  // object would read a game state the permanent is no longer part of.
  const openingCharacteristics = new Map<string, PermanentCharacteristics>();
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    const state = engine.getState();
    if (openingIds.size === 0) {
      for (const permanent of ctx.state.battlefield) {
        openingIds.set(permanent.name, [...(openingIds.get(permanent.name) ?? []), permanent.id]);
        if (!openingCharacteristics.has(permanent.name)) {
          const chars = computeCharacteristics(ctx, permanent);
          openingCharacteristics.set(permanent.name, {
            types: [...chars.types],
            power: chars.power,
            toughness: chars.toughness,
            keywords: [...chars.keywords],
          });
        }
      }
    }
    observations.push({
      phase: state.phase,
      step: state.step,
      stackSize: state.stack.length,
      stackDescriptions: state.stack.map((entry) => entry.description),
      life: state.players.map((player) => player.life),
      entries: state.battlefield.map((permanent) => ({
        name: permanent.name,
        controllerId: permanent.controllerId,
        ownerId: permanent.ownerId,
        tapped: permanent.tapped,
      })),
      hand: state.players[0]!.hand.map((card) => card.name),
      graveyard: state.players[0]!.graveyard.map((card) => card.name),
    });
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 40) throw new Error(`Council's Judgment ${mode} failed to finish`);
    const request = step.request;

    if (isVoteMenu(request)) {
      menus.push({
        prompt: request.prompt,
        decidingPlayer: request.decidingPlayer,
        descriptions: request.legalActions.map((action) => action.description),
        optionTargetSlotCounts: request.legalActions.map((action) => action.targets?.length ?? 0),
        exiledBefore: exileEvents(ctx).length,
        votesBefore: voteEvents(ctx).length,
        battlefieldBefore: state.battlefield.map((permanent) => permanent.name),
      });
      const wanted = PLANNED_VOTES[mode][request.decidingPlayer];
      const action = request.legalActions.find(
        (candidate) => candidate.description === `Vote for ${wanted}`,
      );
      expect(
        action,
        `${request.prompt} offers "${wanted}" to ${request.decidingPlayer}`,
      ).toBeDefined();
      engine.submit({ requestId: request.requestId, actionId: action!.id });
      continue;
    }

    // All four votes are cast and the resolution they belonged to is over: this is the
    // post-resolution priority window the prepared run is meant to stop in.
    if (menus.length === 4 && state.players[0]!.graveyard.some((card) => card.name === COUNCIL)) {
      break;
    }

    const cast = request.legalActions.find(
      (action) => action.type === 'castSpell' && action.description.startsWith(`Cast ${COUNCIL} `),
    );
    if (cast !== undefined) castOrder.push(cast.description);
    const pass = request.legalActions.find((action) => action.type === 'pass');
    const chosen = cast ?? pass ?? request.legalActions[0]!;
    engine.submit({
      requestId: request.requestId,
      actionId: chosen.id,
      ...((chosen.targets ?? []).length === 0
        ? {}
        : {
            targets: chosen.targets!.map((slot) => ({
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
    ctx,
    log: state.eventLog,
    observations,
    menus,
    castOrder,
    openingCharacteristics,
    /** The one object the board started with under that name, as it existed BEFORE any exile. */
    idOf: (name: string): string => {
      const found = openingIds.get(name) ?? [];
      expect(found.length, `${name} objects on the arranged board`).toBe(1);
      return found[0]!;
    },
    haltReason: engine.getResult()?.haltReason ?? null,
  };
}

const events = (run: Replay, type: GameEvent['type']): GameEvent[] =>
  run.log.filter((event) => event.type === type);
const last = (run: Replay): Observation => run.observations.at(-1)!;
/** The published public log for one seat, which is what the viewer renders. */
const publicLines = (run: Replay, viewer: PlayerId): string[] =>
  formatPlayerLog(run.state.eventLog, viewer).map((line) => line.text);

/** Nothing about another seat's private cards may reach P1 through the viewer boundary. */
function expectNoPrivateIdentities(run: Replay): void {
  const projection = run.scenario.engine.playerState('P1');
  expect(projection.viewerSeat).toBe('P1');
  expect(projection.seats).toHaveLength(4);
  const serialized = JSON.stringify(projection);
  for (const player of run.state.players.filter((entry) => entry.id !== 'P1')) {
    const seat = projection.seats.find((entry) => entry.seat === player.id)!;
    expect(seat.hand, `${player.id} hand is withheld`).toBeNull();
    expect(seat.handSize).toBe(player.hand.length);
    for (const card of [...player.hand, ...player.library]) {
      expect(serialized, `${player.id} never publishes ${card.name}`).not.toContain(card.id);
    }
  }
}

/** The arranged board, asserted before anything is cast. Both runs share its shape. */
function expectOpeningBoard(run: Replay, p2Permanent: string): Observation {
  const opening = run.observations[0]!;
  expect(opening.entries.map((entry) => entry.name)).toEqual([
    'Plains',
    'Plains',
    'Plains',
    OWN_RELIC,
    p2Permanent,
    'Forest',
    BETA,
    GAMMA,
  ]);
  expect(opening.life).toEqual([40, 40, 40, 40]);
  expect(opening.hand).toEqual([COUNCIL, WITNESS]);
  expect(opening.stackSize).toBe(0);
  return opening;
}

/** {1}{W}{W} through the real menu, the ordinary payment solver, the stack and resolution. */
function expectRealCast(run: Replay): void {
  expect(run.castOrder).toEqual([`Cast ${COUNCIL} ({1}{W}{W})`]);
  expect(events(run, 'tapForMana').map((event) => event.payload['name'])).toEqual([
    'Plains',
    'Plains',
    'Plains',
  ]);
  expect(events(run, 'castSpell').map((event) => event.payload)).toMatchObject([
    { player: 'P1', name: COUNCIL },
  ]);
  // A sorcery leaves the stack for the graveyard and is never a battlefield permanent.
  expect(events(run, 'zoneChange').map((event) => event.payload)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: COUNCIL, from: 'stack', to: 'graveyard', owner: 'P1' }),
    ]),
  );
  expect(run.state.battlefield.some((entry) => entry.name === COUNCIL)).toBe(false);
  expect(
    run.state.battlefield
      .filter((entry) => entry.name === 'Plains')
      .every((plains) => plains.tapped && plains.controllerId === 'P1'),
  ).toBe(true);
}

/** Four mandatory votes in turn order starting with the ability's controller. */
function expectFourMandatoryVotes(run: Replay, menu: string[]): void {
  expect(run.menus.map((entry) => entry.decidingPlayer)).toEqual(['P1', 'P2', 'P3', 'P4']);
  expect(run.menus.map((entry) => entry.votesBefore)).toEqual([0, 1, 2, 3]);
  for (const entry of run.menus) {
    expect(entry.prompt).toBe(VOTE_PROMPT);
    expect(entry.descriptions).toEqual(menu);
    // A vote is a resolution choice, not a target: no option carried a slot.
    expect(entry.optionTargetSlotCounts).toEqual([0, 0, 0]);
    // Nobody may abstain, so the menu has no "none"/"skip"/"pass" entry at all.
    expect(
      entry.descriptions.some((description) => /none|skip|decline|pass/i.test(description)),
    ).toBe(false);
    // The caster's own nonland permanent and every land are absent from the pool.
    expect(entry.descriptions).not.toContain(`Vote for ${OWN_RELIC}`);
    for (const description of entry.descriptions) {
      expect(/Plains|Forest/.test(description), description).toBe(false);
    }
    // All four votes are cast before a single permanent leaves.
    expect(entry.exiledBefore).toBe(0);
  }
  // The rotation starts at the ability controller, not at the active player, and it happens at
  // RESOLUTION rather than at announcement.
  const castSequence = events(run, 'castSpell')[0]!.sequence;
  expect(voteEvents(run.ctx).every((event) => event.sequence > castSequence)).toBe(true);
}

/** The run stopped in the priority window the spell resolved in, with the witness uncast. */
function expectStoppedInResolutionWindow(run: Replay): void {
  const final = last(run);
  expect(final.phase).toBe('precombatMain');
  expect(final.step).toBeNull();
  expect(final.stackSize).toBe(0);
  expect(final.hand).toEqual([WITNESS]);
  // Combat and the end step were never reached.
  expect(run.log.filter((event) => event.type === 'phaseBegin')).toEqual([]);
  expect(run.log.filter((event) => event.type === 'stepBegin')).toEqual([]);
  // The witness's printed "+1 life" never resolved, so nobody gained anything.
  expect(final.life).toEqual([40, 40, 40, 40]);
  expect(events(run, 'lifeGain')).toEqual([]);
  expect(run.state.players.every((player) => !player.hasLost)).toBe(true);
}

describe("Council's Judgment Card Test Lab replay", () => {
  it('pins the Oracle fixture, the published clause mapping and the two prepared boards', () => {
    expect(councilPin, `${COUNCIL} must be in the pinned PR08 fixture`).toBeDefined();
    expect(councilPin!.sha256).toBe(ORACLE_SHA256);
    expect(councilPin!.card.oracleId).toBe('acf4d685-a718-42f7-9a7a-dee069ae8db2');
    expect(councilPin!.card.manaCost).toBe('{1}{W}{W}');
    expect(councilPin!.card.types).toEqual(['Sorcery']);
    // A modeled claim has to survive the same interpreter the coverage gate uses.
    const def = interpretCard(councilPin!.card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    // Non-targeting: the card's whole vote structure lives in its resolution effect.
    expect(def.spellAbility?.targets).toEqual([]);

    // The uncast witness is a real modeled card, never a blank placeholder.
    expect(interpretCard(WITNESS_ORACLE).modeled).toBe(true);
    expect(interpretCard(WITNESS_ORACLE).unmodeledReasons).toEqual([]);

    // The hexproof permanent is a real printed creature, not a name wearing a fake keyword: it has
    // to interpret completely or the unanimous run's negative would prove nothing.
    const run = replay('unanimous-hexproof');
    const chars = run.openingCharacteristics.get(SENTINEL);
    expect(chars, `${SENTINEL} is on the arranged board`).toBeDefined();
    expect(chars!.types).toEqual(['Creature']);
    expect(chars!.power).toBe(0);
    expect(chars!.toughness).toBe(3);
    expect(chars!.keywords).toContain('defender');
    expect(chars!.keywords).toContain('hexproof');

    for (const mode of ['tied-votes', 'unanimous-hexproof'] as const) {
      const scenario = createCardTestScenario(`councils-judgment-viewer-${mode}`, 'pr08-council');
      expect(scenario, mode).not.toBeNull();
      // Both clause IDs ride on BOTH scenarios: each run resolves both printed sentences, so
      // neither is allowed to be scoped to a single run.
      expect(scenario!.metadata.clauseIds, mode).toEqual([
        'councils-judgment-public-voting',
        'councils-judgment-most-votes-exile',
      ]);
      expect(scenario!.metadata.oracleSha256, mode).toBe(ORACLE_SHA256);
      expect(scenario!.metadata.title, mode).toBe(TITLES[mode]);
    }
  });

  it('councils-judgment-viewer-tied-votes — a 2:2 tie exiles both winners and spares the unvoted one', () => {
    const first = replay('tied-votes');
    const second = replay('tied-votes');
    // Same seed, same planned decisions, identical event stream: every claim below is about the
    // engine rather than about one lucky run.
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.castOrder).toEqual(second.castOrder);
    expect(first.haltReason).toBeNull();

    // The arranged board IS the scenario. Every fixture is a printed permanent with real
    // characteristics — never a `noOp` placeholder wearing a name.
    expectOpeningBoard(first, ALPHA);
    expectRealCast(first);
    expectFourMandatoryVotes(first, [`Vote for ${ALPHA}`, `Vote for ${BETA}`, `Vote for ${GAMMA}`]);
    // The whole board is still standing at every menu, including the two eventual winners.
    for (const entry of first.menus) {
      expect(entry.battlefieldBefore).toContain(ALPHA);
      expect(entry.battlefieldBefore).toContain(BETA);
      expect(entry.battlefieldBefore).toContain(GAMMA);
    }

    // Every vote is public, and public means public: every seat reads the same four lines.
    const votes = voteEvents(first.ctx);
    expect(votes.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(votes.map((event) => event.payload['voter'])).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(votes.map((event) => event.payload['name'])).toEqual([ALPHA, ALPHA, BETA, BETA]);
    for (const vote of votes) expect(vote.payload['source']).toBe(COUNCIL);
    // The vote binds the exact OBJECT, not just a card name.
    expect(votes.map((event) => event.payload['objectId'])).toEqual([
      first.idOf(ALPHA),
      first.idOf(ALPHA),
      first.idOf(BETA),
      first.idOf(BETA),
    ]);
    for (const viewer of ['P1', 'P2', 'P3', 'P4'] as PlayerId[]) {
      expect(publicLines(first, viewer).filter((line) => line.includes('votes for'))).toEqual([
        `${COUNCIL}: P1 votes for ${ALPHA}`,
        `${COUNCIL}: P2 votes for ${ALPHA}`,
        `${COUNCIL}: P3 votes for ${BETA}`,
        `${COUNCIL}: P4 votes for ${BETA}`,
      ]);
    }
    // The last vote is strictly before the first departure: nothing leaves until all four are cast.
    expect(votes.at(-1)!.sequence).toBeLessThan(exileEvents(first.ctx)[0]!.sequence);

    // 2:2 — "the most votes or tied for most votes" exiles BOTH winners, and spares the one that
    // received no vote at all.
    expect(
      exileEvents(first.ctx)
        .map((event) => event.payload['name'])
        .sort(),
    ).toEqual([ALPHA, BETA].sort());
    expect(first.state.battlefield.map((entry) => entry.name)).toEqual([
      'Plains',
      'Plains',
      'Plains',
      OWN_RELIC,
      'Forest',
      GAMMA,
    ]);
    // The spell's own sorcery went to the graveyard as an ordinary spell.
    expect(
      first.state.players.find((player) => player.id === 'P1')!.graveyard.map((card) => card.name),
    ).toEqual([COUNCIL]);
    expectStoppedInResolutionWindow(first);

    expectNoPrivateIdentities(first);
    // The vote names a battlefield permanent only — no hand or library identity is recorded.
    const voted = JSON.stringify(votes.map((vote) => vote.payload));
    expect(voted).not.toContain('library');
    expect(voted).not.toContain('Island');
  });

  it('councils-judgment-viewer-unanimous-hexproof — four votes for one permanent exile only that object', () => {
    const first = replay('unanimous-hexproof');
    const second = replay('unanimous-hexproof');
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.castOrder).toEqual(second.castOrder);
    expect(first.haltReason).toBeNull();

    expectOpeningBoard(first, SENTINEL);
    expectRealCast(first);
    // The hexproof creature is on the menu like any other object: "votes for a permanent you don't
    // control" is not a targeting clause, so its keyword removes no option.
    expectFourMandatoryVotes(first, [
      `Vote for ${SENTINEL}`,
      `Vote for ${BETA}`,
      `Vote for ${GAMMA}`,
    ]);
    for (const entry of first.menus) expect(entry.battlefieldBefore).toContain(SENTINEL);

    // 4:0:0 — only the unanimous winner has "the most votes", and only it leaves.
    const votes = voteEvents(first.ctx);
    expect(votes.map((event) => event.payload['name'])).toEqual([
      SENTINEL,
      SENTINEL,
      SENTINEL,
      SENTINEL,
    ]);
    expect(votes.map((event) => event.payload['objectId'])).toEqual(
      Array.from({ length: 4 }, () => first.idOf(SENTINEL)),
    );
    for (const viewer of ['P1', 'P2', 'P3', 'P4'] as PlayerId[]) {
      expect(publicLines(first, viewer).filter((line) => line.includes('votes for'))).toEqual(
        [1, 2, 3, 4].map((seat) => `${COUNCIL}: P${seat} votes for ${SENTINEL}`),
      );
    }
    expect(votes.at(-1)!.sequence).toBeLessThan(exileEvents(first.ctx)[0]!.sequence);
    expect(exileEvents(first.ctx).map((event) => event.payload['name'])).toEqual([SENTINEL]);

    // The zero-vote bystanders, the caster's own nonland permanent and every land all stay.
    expect(first.state.battlefield.map((entry) => entry.name)).toEqual([
      'Plains',
      'Plains',
      'Plains',
      OWN_RELIC,
      'Forest',
      BETA,
      GAMMA,
    ]);
    expectStoppedInResolutionWindow(first);
    expectNoPrivateIdentities(first);
  });
});
