/**
 * PR08.22: Benevolent Offering — Card Test Lab replay.
 *
 * Both scenarios run the printed {3}{W} instant through the production engine: real legality, the
 * ordinary payment solver choosing the four Plains, the real stack, real priority passes, real
 * resolution and the real decisions the spell asks for. Nothing here arranges an outcome — the
 * assertions read the authoritative engine state and the complete event stream after replaying the
 * scenario, and the only difference the two runs are allowed to have is the one the card's own text
 * allows: whether the SECOND opponent choice repeats the first.
 *
 * What the replay pins:
 *
 *  - {3}{W} was paid for with exactly four Plains, through ordinary mana selection: four
 *    `tapForMana` events and one `castSpell` for P1, followed by a real zone change off the stack
 *    into the graveyard. The source is an instant, so it is never a battlefield permanent.
 *  - The spell has NO targets. There are no target slots on the cast action and none on either
 *    choice, which is what makes these choices resolution instructions rather than targets — and
 *    why an opponent's hexproof could never exclude one.
 *  - Both choices are asked of P1, the ORIGINAL controller, only after the spell is on the stack,
 *    and they are asked separately: one prompt for the Spirits, a second, independent prompt for
 *    the life.
 *  - The second prompt arrives only after all six Spirits exist. "You gain 2 life for each creature
 *    you control" therefore reads 4 for P1 and 4 for P2 (their own creature plus the three they
 *    just made), while P3 reads 2 and P4 reads 0 — and every life total is still 40 at that
 *    moment, because nothing has gained anything yet.
 *  - Both counts are read before either life total moves: one simultaneous event, so a player can
 *    never observe a half-finished gain.
 *  - The same opponent may answer the second prompt. The run that names P2 twice is not a
 *    loophole in the test; it is the printed text, and it is a separate published scenario.
 *
 * The board is arranged with printed, fully interpreted 0/3 Defenders and one printed noncreature
 * artifact, so "each creature" is arithmetic over four different numbers and never over
 * "permanent". No blank spell, no force-declared `modeled: true`, no `noOp` stand-in appears
 * anywhere: the only card left in hand is a real {0} instant with a printed, resolvable effect.
 */
import { readFileSync } from 'node:fs';
import { interpretCard } from '@mtg/engine';
import type { DecisionRequest, GameEvent, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../../../engine/src/effects/continuous';
import type { EnginePermanent, GameContext } from '../../../engine/src/state/types';
import { createCardTestScenario } from './card-test-scenarios';

type Mode = 'different-opponents' | 'same-opponent';

const OFFERING = 'Benevolent Offering';
const WITNESS = 'Lab Priority Witness';
const SPIRIT = 'Spirit';
const P1_CREATURE = 'Lab Offering Sentinel';
const P2_CREATURE = 'Lab Offering Wall';
const P3_CREATURE = 'Lab Offering Golem';
const P4_NONCREATURE = 'Lab Silent Relic';
const SPIRIT_PROMPT = `${OFFERING}: choose an opponent to create tokens with you`;
const LIFE_PROMPT = `${OFFERING}: choose an opponent to gain life for their creatures`;
const ORACLE_SHA256 = '4da93215102bbd43f1bc01e0ded2313ab4923995859e87e016e2a5481e09739a';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards;
const offeringPin = pins.find((entry) => entry.card.name === OFFERING);

interface BoardEntry {
  name: string;
  controllerId: string;
  ownerId: string;
  tapped: boolean;
  isToken: boolean;
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

type Replay = ReturnType<typeof replay>;

/** The opponent menu this spell asks for, which is never a target and never includes P1. */
function isOpponentChoice(request: DecisionRequest): boolean {
  return (
    request.legalActions.length > 0 &&
    request.legalActions.every((action) => action.type === 'choosePlayer')
  );
}

/** The names currently on the battlefield as tokens — the catalog's only token on this board. */
function tokenNameSet(ctx: GameContext): Set<string> {
  return new Set(
    ctx.state.battlefield
      .filter((permanent) => permanent.isToken)
      .map((permanent) => permanent.name),
  );
}

function replay(mode: Mode) {
  const scenario = createCardTestScenario(
    `benevolent-offering-viewer-${mode}`,
    'pr08-offering-lab',
  );
  expect(scenario, `scenario benevolent-offering-viewer-${mode}`).not.toBeNull();
  const engine = scenario!.engine;
  const observations: Observation[] = [];
  /** Every opponent menu, in the order the engine presented it, with the board it was asked on. */
  const menus: {
    prompt: string;
    descriptions: string[];
    decidingPlayer: string;
    stackDescriptions: string[];
    tokenCount: number;
    life: number[];
  }[] = [];
  const castOrder: string[] = [];
  // Token-ness is an engine-side fact, not part of the published projection, so it is read from the
  // authoritative context rather than inferred from a name.
  const ctx = (engine as unknown as { ctx: GameContext }).ctx;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    const state = engine.getState();
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
        isToken: tokenNameSet(ctx).has(permanent.name),
      })),
      hand: state.players[0]!.hand.map((card) => card.name),
      graveyard: state.players[0]!.graveyard.map((card) => card.name),
    });
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 40) throw new Error(`Benevolent Offering ${mode} failed to finish`);
    const request = step.request;

    if (isOpponentChoice(request)) {
      // The board is read at the moment the question is asked, not reconstructed afterwards, so
      // "the tokens already exist" and "nobody has gained life yet" are observations.
      menus.push({
        prompt: request.prompt,
        descriptions: request.legalActions.map((action) => action.description),
        decidingPlayer: request.decidingPlayer,
        stackDescriptions: state.stack.map((entry) => entry.description),
        tokenCount: ctx.state.battlefield.filter((permanent) => permanent.isToken).length,
        life: state.players.map((player) => player.life),
      });
      const wanted = menus.length === 1 ? 'P2' : mode === 'same-opponent' ? 'P2' : 'P3';
      const action = request.legalActions.find((candidate) =>
        candidate.description.startsWith(`${wanted} `),
      );
      expect(action, `${request.prompt} offers ${wanted}`).toBeDefined();
      engine.submit({ requestId: request.requestId, actionId: action!.id });
      continue;
    }

    // Both questions have been answered and the resolution they belonged to is over: this is the
    // post-resolution precombat priority window the prepared run is meant to stop in.
    if (menus.length === 2 && state.players[0]!.graveyard.some((card) => card.name === OFFERING))
      break;

    const cast = request.legalActions.find(
      (action) => action.type === 'castSpell' && action.description.startsWith(`Cast ${OFFERING} `),
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
    ctx: (engine as unknown as { ctx: GameContext }).ctx,
    log: state.eventLog,
    observations,
    menus,
    castOrder,
    haltReason: engine.getResult()?.haltReason ?? null,
  };
}

const events = (run: Replay, type: GameEvent['type']): GameEvent[] =>
  run.log.filter((event) => event.type === type);
const last = (run: Replay): Observation => run.observations.at(-1)!;
const life = (run: Replay, seat: string): number =>
  run.state.players.find((player) => player.id === seat)!.life;
const tokensOf = (run: Replay, controllerId: string): EnginePermanent[] =>
  run.ctx.state.battlefield.filter(
    (permanent) => permanent.isToken && permanent.controllerId === controllerId,
  );
const permanentOf = (run: Replay, name: string): EnginePermanent => {
  const found = run.ctx.state.battlefield.filter((entry) => entry.name === name);
  expect(found.length, `${name} permanents on the battlefield`).toBeGreaterThan(0);
  return found[0]!;
};

describe('Benevolent Offering Card Test Lab replay', () => {
  it('pins the Oracle fixture, the published clause mapping and the two prepared boards', () => {
    expect(offeringPin, `${OFFERING} must be in the pinned PR08 fixture`).toBeDefined();
    expect(offeringPin!.sha256).toBe(ORACLE_SHA256);
    expect(offeringPin!.card.oracleId).toBe('3db8466c-864f-48ba-b617-f2c863dfdcbd');
    expect(offeringPin!.card.manaCost).toBe('{3}{W}');
    expect(offeringPin!.card.types).toEqual(['Instant']);
    // A modeled claim has to survive the same interpreter the coverage gate uses.
    const def = interpretCard(offeringPin!.card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.spellAbility?.targets).toEqual([]);

    const titles: Record<Mode, string> = {
      'different-opponents': `${OFFERING}: choose P2 for the Spirits and P3 for the life`,
      'same-opponent': `${OFFERING}: choose the same opponent twice, for the Spirits and for the life`,
    };
    for (const mode of ['different-opponents', 'same-opponent'] as const) {
      const scenario = createCardTestScenario(
        `benevolent-offering-viewer-${mode}`,
        'pr08-offering',
      );
      expect(scenario, mode).not.toBeNull();
      // Both clause IDs ride on BOTH scenarios: each run resolves both printed instructions, so
      // neither is allowed to be scoped to a single run.
      expect(scenario!.metadata.clauseIds, mode).toEqual([
        'benevolent-offering-spirit-sharing',
        'benevolent-offering-creature-life-sharing',
      ]);
      expect(scenario!.metadata.oracleSha256, mode).toBe(ORACLE_SHA256);
      expect(scenario!.metadata.title, mode).toBe(titles[mode]);
    }
  });

  it('benevolent-offering-viewer-different-opponents — P2 makes the Spirits and P3 makes the life', () => {
    const first = replay('different-opponents');
    const second = replay('different-opponents');
    // Same seed, same scripted decisions, identical event stream: every claim below is about the
    // engine rather than about one lucky run.
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.castOrder).toEqual(second.castOrder);
    expect(first.haltReason).toBeNull();

    // The arranged board IS the scenario. Every fixture is a printed creature with real
    // characteristics — never a `noOp` placeholder wearing a name.
    const opening = first.observations[0]!;
    expect(opening.entries.map((entry) => entry.name)).toEqual([
      'Plains',
      'Plains',
      'Plains',
      'Plains',
      P1_CREATURE,
      P2_CREATURE,
      P3_CREATURE,
      P3_CREATURE,
      P4_NONCREATURE,
    ]);
    expect(opening.life).toEqual([40, 40, 40, 40]);
    expect(opening.hand).toEqual([OFFERING, WITNESS]);
    for (const name of [P1_CREATURE, P2_CREATURE, P3_CREATURE]) {
      const chars = computeCharacteristics(first.ctx, permanentOf(first, name));
      expect(chars.types, name).toEqual(['Creature']);
      expect(chars.power, name).toBe(0);
      expect(chars.toughness, name).toBe(3);
      expect(chars.keywords, name).toContain('defender');
    }
    const relicChars = computeCharacteristics(first.ctx, permanentOf(first, P4_NONCREATURE));
    expect(relicChars.types).toEqual(['Artifact']);
    expect(relicChars.types).not.toContain('Creature');

    // {3}{W} was paid for with exactly the four Plains, through ordinary mana selection, and the
    // spell has no targets at all.
    expect(first.castOrder).toEqual([`Cast ${OFFERING} ({3}{W})`]);
    expect(events(first, 'tapForMana').map((event) => event.payload['name'])).toEqual([
      'Plains',
      'Plains',
      'Plains',
      'Plains',
    ]);
    expect(events(first, 'castSpell').map((event) => event.payload)).toMatchObject([
      { player: 'P1', name: OFFERING },
    ]);
    const castRequest = first.log.filter((event) => event.type === 'decision');
    expect(castRequest.length).toBeGreaterThan(0);
    expect(
      first.state.battlefield
        .filter((entry) => entry.name === 'Plains')
        .every((plains) => plains.tapped && plains.controllerId === 'P1'),
    ).toBe(true);
    // The source is an instant: it leaves the stack for the graveyard, never the battlefield.
    expect(events(first, 'zoneChange').map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: OFFERING, from: 'stack', to: 'graveyard', owner: 'P1' }),
      ]),
    );
    expect(first.state.battlefield.some((entry) => entry.name === OFFERING)).toBe(false);

    // Two separate menus, both asked of the ORIGINAL controller, and never of the caster. The
    // spell has already left the stack by the time it asks (CR 608.4 puts it there for resolution
    // but the engine pops it first), so an empty stack at each menu is the correct reading — the
    // ordering evidence is the event sequence asserted below, not the live stack.
    expect(first.menus).toHaveLength(2);
    expect(first.menus.map((menu) => menu.prompt)).toEqual([SPIRIT_PROMPT, LIFE_PROMPT]);
    expect(
      first.observations.some((observation) =>
        observation.stackDescriptions.some((entry) => entry.includes(OFFERING)),
      ),
    ).toBe(true);
    // Each menu always names every living opponent and never the caster, and each option repeats the
    // instruction that asked it. These are the exact strings the viewer's buttons carry.
    const menus = [
      [
        'P2 to create tokens with you',
        'P3 to create tokens with you',
        'P4 to create tokens with you',
      ],
      [
        'P2 to gain life for their creatures',
        'P3 to gain life for their creatures',
        'P4 to gain life for their creatures',
      ],
    ];
    for (const [index, menu] of first.menus.entries()) {
      expect(menu.decidingPlayer).toBe('P1');
      expect(menu.stackDescriptions).toEqual([]);
      expect(menu.descriptions).toEqual(menus[index]);
      // No P1, and no target slots on any option: resolution choices, not targets.
      expect(menu.descriptions.some((description) => description.startsWith('P1 '))).toBe(false);
    }

    // The FIRST menu is asked on the board as it was arranged: nothing has been created yet.
    expect(first.menus[0]!.tokenCount).toBe(0);
    // The SECOND menu is asked only after all six Spirits exist — and still before any life
    // total has moved, so the counts it will read are not half-applied.
    expect(first.menus[1]!.tokenCount).toBe(6);
    expect(first.menus[1]!.life).toEqual([40, 40, 40, 40]);

    // Both prompts are asked after the spell went on the stack, never at announcement.
    const castSequence = events(first, 'castSpell')[0]!.sequence;
    const choices = events(first, 'chooseOpponent');
    expect(choices).toHaveLength(2);
    expect(choices.map((event) => event.payload)).toMatchObject([
      { source: OFFERING, player: 'P2' },
      { source: OFFERING, player: 'P3' },
    ]);
    expect(choices.every((event) => event.actorSeat === 'P1')).toBe(true);
    expect(choices.every((event) => event.sequence > castSequence)).toBe(true);

    // Exactly six tokens: three for the caster and three for the chosen opponent, each created by
    // its own creator and owned by it.
    expect(events(first, 'tokenCreated')).toHaveLength(6);
    const spirits = first.ctx.state.battlefield.filter((permanent) => permanent.isToken);
    expect(spirits.map((permanent) => permanent.controllerId).sort()).toEqual([
      'P1',
      'P1',
      'P1',
      'P2',
      'P2',
      'P2',
    ]);
    for (const spirit of spirits) {
      expect(spirit.ownerId).toBe(spirit.controllerId);
      expect(spirit.tapped).toBe(false);
      expect(computeCharacteristics(first.ctx, spirit)).toMatchObject({
        types: ['Creature'],
        subtypes: [SPIRIT],
        colors: ['W'],
        power: 1,
        toughness: 1,
        keywords: ['flying'],
      });
    }
    expect(tokensOf(first, 'P1')).toHaveLength(3);
    expect(tokensOf(first, 'P2')).toHaveLength(3);
    expect(tokensOf(first, 'P3')).toHaveLength(0);
    expect(tokensOf(first, 'P4')).toHaveLength(0);

    // The life event is ONE simultaneous event: both counts were read before either total moved,
    // so 8 is 2 × P1's four creatures (its own plus the three it just made) and 4 is 2 × P3's two.
    const gains = events(first, 'lifeGain').map((event) => event.payload);
    expect(gains.map((gain) => gain['player']).sort()).toEqual(['P1', 'P3']);
    expect(gains).toEqual(
      expect.arrayContaining([
        { player: 'P1', amount: 8, life: 48 },
        { player: 'P3', amount: 4, life: 44 },
      ]),
    );
    expect(life(first, 'P1')).toBe(48);
    expect(life(first, 'P2')).toBe(40);
    expect(life(first, 'P3')).toBe(44);
    expect(life(first, 'P4')).toBe(40);

    // Nobody involved lost, and the bystanders are exactly where they started: P2 was not the
    // life player, P4 owns an artifact rather than a creature, and no pre-existing permanent moved.
    expect(first.state.players.every((player) => !player.hasLost)).toBe(true);
    const final = last(first);
    for (const [name, controllerId, count] of [
      [P1_CREATURE, 'P1', 1],
      [P2_CREATURE, 'P2', 1],
      [P3_CREATURE, 'P3', 2],
      [P4_NONCREATURE, 'P4', 1],
    ] as const) {
      const held = final.entries.filter((entry) => entry.name === name);
      expect(held, name).toHaveLength(count);
      expect(
        held.every(
          (entry) => entry.controllerId === controllerId && entry.ownerId === controllerId,
        ),
        name,
      ).toBe(true);
      expect(
        held.some((entry) => entry.isToken),
        `${name} was never copied or duplicated`,
      ).toBe(false);
    }

    // The run stopped where it was meant to: the precombat priority window the spell resolved in.
    // Combat and the end step were never reached, and the unused witness is still castable in hand.
    expect(final.phase).toBe('precombatMain');
    expect(final.stackSize).toBe(0);
    expect(final.hand).toEqual([WITNESS]);
    expect(final.graveyard).toEqual([OFFERING]);
    expect(first.log.filter((event) => event.type === 'phaseBegin')).toEqual([]);
    expect(first.log.filter((event) => event.type === 'stepBegin')).toEqual([]);

    // The viewer projection this run would publish keeps every opponent's hidden cards hidden.
    const projection = first.scenario.engine.playerState('P1');
    expect(projection.viewerSeat).toBe('P1');
    expect(projection.seats).toHaveLength(4);
    const serialized = JSON.stringify(projection);
    for (const player of first.state.players.filter((entry) => entry.id !== 'P1')) {
      const seat = projection.seats.find((entry) => entry.seat === player.id)!;
      expect(seat.hand, `${player.id} hand is withheld`).toBeNull();
      expect(seat.handSize).toBe(player.hand.length);
      for (const card of [...player.hand, ...player.library]) {
        expect(serialized, `${player.id} never publishes ${card.name}`).not.toContain(card.id);
      }
    }
    const published = projection.battlefield.filter((entry) => entry.name === SPIRIT);
    expect(published).toHaveLength(6);
    expect(
      published.map((entry) => `${entry.owner}/${entry.controller}/${entry.tapped}`).sort(),
    ).toEqual([
      'P1/P1/false',
      'P1/P1/false',
      'P1/P1/false',
      'P2/P2/false',
      'P2/P2/false',
      'P2/P2/false',
    ]);
    expect(published.every((entry) => entry.power === 1 && entry.toughness === 1)).toBe(true);
    expect(published.every((entry) => entry.keywords.includes('flying'))).toBe(true);
  });

  it('benevolent-offering-viewer-same-opponent — P2 answers both questions and gains life for its own four creatures', () => {
    const first = replay('same-opponent');
    const second = replay('same-opponent');
    expect(first.log).toEqual(second.log);
    expect(first.menus).toEqual(second.menus);
    expect(first.haltReason).toBeNull();

    // The same opponent is still on the menu the second time: it was not filtered out, and the
    // caster is still not.
    expect(first.menus.map((menu) => menu.prompt)).toEqual([SPIRIT_PROMPT, LIFE_PROMPT]);
    expect(first.menus[1]!.descriptions).toEqual([
      'P2 to gain life for their creatures',
      'P3 to gain life for their creatures',
      'P4 to gain life for their creatures',
    ]);
    expect(first.menus[1]!.tokenCount).toBe(6);
    expect(first.menus[1]!.life).toEqual([40, 40, 40, 40]);

    // Both instructions named P2, so both halves of the effect went to the same player: the same
    // six tokens as the other run, and P2 now gains for its own four creatures.
    const choices = events(first, 'chooseOpponent').map((event) => event.payload);
    expect(choices).toMatchObject([
      { source: OFFERING, player: 'P2' },
      { source: OFFERING, player: 'P2' },
    ]);
    expect(tokensOf(first, 'P1')).toHaveLength(3);
    expect(tokensOf(first, 'P2')).toHaveLength(3);
    expect(events(first, 'lifeGain').map((event) => event.payload)).toMatchObject([
      { player: 'P1', amount: 8, life: 48 },
      { player: 'P2', amount: 8, life: 48 },
    ]);
    expect(first.state.players.map((player) => player.life)).toEqual([48, 48, 40, 40]);

    // P3 and P4 are untouched, which is what separates this run from the other one.
    expect(life(first, 'P3')).toBe(40);
    expect(life(first, 'P4')).toBe(40);
    expect(tokensOf(first, 'P3')).toHaveLength(0);
    expect(tokensOf(first, 'P4')).toHaveLength(0);
    expect(events(first, 'tokenCreated')).toHaveLength(6);
    expect(events(first, 'tapForMana')).toHaveLength(4);
    expect(first.state.players.every((player) => !player.hasLost)).toBe(true);

    const final = last(first);
    expect(final.phase).toBe('precombatMain');
    expect(final.stackSize).toBe(0);
    expect(final.hand).toEqual([WITNESS]);
    expect(final.graveyard).toEqual([OFFERING]);
  });
});
