/**
 * PR01 card coverage: targeting, optional choices, and resolution fidelity
 * (docs/plans/card-coverage-chunks.md).
 *
 * Each restored card has a `describe` block whose test names start with the engine test IDs the
 * verification manifest declares for it. The gate at the bottom ties the two together: every
 * restored card must be pinned, modeled under both its real Oracle ID and its fixture alias,
 * declared `implemented-reviewed` in the manifest, and mapped to engine tests in this file and to
 * Card Test Lab scenarios that the real-viewer Playwright spec exercises.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ObjectId, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  permanentManaValue,
  type PriorityActionPayload,
} from '../src/actions/legal';
import type { Ability, Effect } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { allOf, ofSupertype, ofType, YOURS } from '../src/cards/selector';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers, runCombatAndExtraCombats } from '../src/turn/turn';
import { playPreparedScenario } from '../src/flow/game';
import { createGame } from '../src/state/game';
import { prepareScenario, type PreparedScenarioSpec } from '../src/testing/prepared-scenario';
import { moveObject, playerById, transformPermanent } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { formatPlayerLog } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import {
  bear,
  conjure,
  copies,
  declareAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  island,
  oracle,
  plains,
  pump,
  spawn,
  swamp,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json', 'fixtures/coverage-pr01-oracle.json'];
const pinnedCards = PINNED_FILES.flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')) as PinnedFixture).cards,
);

function pinned(name: string): { sha256: string; card: OracleCard } {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry;
}

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function optionMatching(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0) {
    throw new Error(
      `no option matching ${String(pattern)} in: ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  }
  return { index, targets: new Map() };
}

/** Answer each decision whose prompt matches with the option matching the paired pattern. */
function answers(rules: [prompt: RegExp, option: RegExp][]): Answer {
  return (decision) => {
    for (const [prompt, option] of rules) {
      if (prompt.test(decision.prompt)) return optionMatching(decision, option);
    }
    return { index: 0, targets: new Map() };
  };
}

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

function activationOf(ctx: GameContext, playerId: string, source: EnginePermanent) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}

/** Take a priority action through the normal legality/payment path and leave it on the stack. */
function takeAction(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  answer?: Answer,
  targets: ReadonlyMap<number, string> = new Map(),
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }),
    answer,
  );
}

/** The priority option that casts `objectId` from its current zone, if it is legal now. */
function castOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(resolveTopOfStack(ctx), answer);
}

/**
 * Run the normal priority loop with every player passing: pending triggers go on the stack and
 * resolve in order. Non-priority decisions go to `answer` (default: first option).
 */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

/** Move a card onto the battlefield through the normal zone change, queueing its triggers. */
function enter(
  ctx: GameContext,
  controllerId: string,
  card: OracleCard,
  opts?: { token?: boolean },
) {
  const object = conjure(ctx, controllerId, card, 'hand');
  if (opts?.token === true) object.isToken = true;
  pump(moveObject(ctx, object, { zone: 'battlefield', controllerId }));
  return object;
}

function spellAbilityOf(effects: Effect[]): Ability {
  return { kind: 'spell', targets: [], effects };
}

const SECRET = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// ---------------------------------------------------------------------------------------------
// 1.01 Forum of Amity
// ---------------------------------------------------------------------------------------------

describe('Forum of Amity', () => {
  const forum = pinned('Forum of Amity');

  function readyForum(seed: string) {
    const ctx = pod(seed);
    const land = spawn(ctx, 'P1', forum.card);
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'W' },
      { symbol: 'B' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    return { ctx, land };
  }

  it('forum-of-amity-pinned-oracle-supported — pins the exact Oracle and both supported ids', () => {
    expect(forum.sha256).toBe('b49800b6e3d748f53ad05c73cbf239e4c57e16fac1e8288c5fdf8d1f36b384ee');
    expect(forum.card.oracleText).toBe(
      'This land enters tapped.\n{T}: Add {W} or {B}.\n{2}{W}{B}, {T}: Surveil 1. (Look at the top card of your library. You may put it into your graveyard.)',
    );
    const def = interpretCard(forum.card);
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W', 'B']] }]);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]!.ability.effects).toEqual([{ op: 'surveil', count: 1 }]);
    expect(getOverride(forum.card.oracleId)).toBeUndefined();
    expect(
      interpretCard({ ...forum.card, oracleId: fixtureOracleId(forum.card.name) }).modeled,
    ).toBe(true);
  });

  it('forum-of-amity-enters-tapped — a normal land play puts it onto the battlefield tapped', () => {
    const ctx = pod('forum-land-play');
    const inHand = conjure(ctx, 'P1', forum.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(play).toBeDefined();
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    const entered = ctx.state.battlefield.find((entry) => entry.cardId === inHand.cardId);
    expect(entered?.tapped).toBe(true);
  });

  it('forum-of-amity-surveil-to-graveyard — normal activation surveils the top card into the graveyard', () => {
    const { ctx, land } = readyForum('forum-surveil-graveyard');
    const top = conjure(ctx, 'P1', SECRET('Forum Top Card'), 'library');
    const activation = activationOf(ctx, 'P1', land);
    expect(activation).toBeDefined();
    takeAction(ctx, 'P1', activation!.payload as PriorityActionPayload);
    expect(land.tapped).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(ctx.state.stack).toHaveLength(1);

    resolveTop(ctx, answers([[/surveil/, /Put Forum Top Card into your graveyard/]]));

    const p1 = playerById(ctx, 'P1');
    expect(p1.graveyard.map((card) => card.cardId)).toContain(top.cardId);
    expect(p1.library.some((card) => card.cardId === top.cardId)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'surveil')).toBe(true);
  });

  it('forum-of-amity-surveil-keep-on-top — keeping the card leaves the library order unchanged', () => {
    const { ctx, land } = readyForum('forum-surveil-keep');
    const top = conjure(ctx, 'P1', SECRET('Forum Kept Card'), 'library');
    const before = playerById(ctx, 'P1').library.map((card) => card.cardId);
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);

    const { decisions } = resolveTop(ctx, answers([[/surveil/, /Keep Forum Kept Card on top/]]));

    expect(decisions.filter((decision) => /surveil/.test(decision.prompt))).toHaveLength(1);
    expect(playerById(ctx, 'P1').library[0]?.cardId).toBe(top.cardId);
    expect(playerById(ctx, 'P1').library.map((card) => card.cardId)).toEqual(before);
  });

  it('forum-of-amity-activation-costs — needs {2}{W}{B} and an untapped Forum', () => {
    const ctx = pod('forum-costs');
    const land = spawn(ctx, 'P1', forum.card);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(activationOf(ctx, 'P1', land)).toBeUndefined();

    const tapped = readyForum('forum-tapped');
    tapped.land.tapped = true;
    expect(activationOf(tapped.ctx, 'P1', tapped.land)).toBeUndefined();
    expect(activationOf(tapped.ctx, 'P2', tapped.land)).toBeUndefined();
  });

  it('forum-of-amity-surveil-privacy — opponents never see the surveilled card kept on top', () => {
    const { ctx, land } = readyForum('forum-privacy');
    conjure(ctx, 'P1', SECRET('Forum Private Secret'), 'library');
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);
    resolveTop(ctx, answers([[/surveil/, /Keep Forum Private Secret on top/]]));
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Forum Private Secret');
  });

  it('forum-of-amity-empty-library — surveil with no library asks nothing and changes nothing', () => {
    const { ctx, land } = readyForum('forum-empty-library');
    playerById(ctx, 'P1').library = [];
    takeAction(ctx, 'P1', activationOf(ctx, 'P1', land)!.payload as PriorityActionPayload);
    const { decisions } = resolveTop(ctx);
    expect(decisions.filter((decision) => /surveil/.test(decision.prompt))).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
    expect(ctx.state.stack).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.02 Attune with Aether
// ---------------------------------------------------------------------------------------------

describe('Attune with Aether', () => {
  const attune = pinned('Attune with Aether');
  const NONBASIC = () =>
    oracle({ name: 'Attune Nonbasic Land', typeLine: 'Land', manaCost: null, oracleText: '' });

  function castAttune(seed: string, answer?: Answer) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', attune.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    const cast = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === inHand.id;
    });
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    return { ctx, inHand, resolved: () => resolveTop(ctx, answer) };
  }

  it('attune-with-aether-pinned-oracle-supported — pins the Oracle and models the whole line', () => {
    expect(attune.sha256).toBe('e1dc515b653e7e3f91dda25d2ed30a27208e28a623ab2be3604d643119e57c94');
    expect(attune.card.oracleText).toBe(
      'Search your library for a basic land card, reveal it, put it into your hand, then shuffle. You get {E}{E} (two energy counters).',
    );
    const def = interpretCard(attune.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      expect.objectContaining({ op: 'searchLibrary', reveal: true, allowFailToFind: true }),
      { op: 'shuffle' },
      expect.objectContaining({ op: 'gainEnergy' }),
    ]);
  });

  it('attune-with-aether-reveal-to-hand — normal cast reveals the found basic, puts it in hand, shuffles, and gives {E}{E}', () => {
    const { ctx } = castAttune('attune-reveal', answers([[/search your library/, /Put Forest/]]));
    const forestInLibrary = playerById(ctx, 'P1').library.find((card) => card.name === 'Forest')!;
    const handBefore = playerById(ctx, 'P1').hand.length;
    resolveTop(ctx, answers([[/search your library/, /Put Forest into your hand/]]));

    const p1 = playerById(ctx, 'P1');
    expect(p1.hand.map((card) => card.cardId)).toContain(forestInLibrary.cardId);
    expect(p1.hand).toHaveLength(handBefore + 1);
    expect(p1.energy).toBe(2);
    expect(p1.graveyard.map((card) => card.name)).toEqual(['Attune with Aether']);
    const found = ctx.state.eventLog.find((event) => event.type === 'searchFound');
    expect(found?.payload).toMatchObject({ name: 'Forest', to: 'hand', revealed: true });
    const types = ctx.state.eventLog.map((event) => event.type);
    expect(types.indexOf('shuffle')).toBeGreaterThan(types.indexOf('searchFound'));
  });

  it('attune-with-aether-reveal-is-public — every opponent sees the revealed card but no other library card', () => {
    const { ctx } = castAttune('attune-public');
    conjure(ctx, 'P1', SECRET('Attune Private Secret'), 'library');
    resolveTop(ctx, answers([[/search your library/, /Put Forest into your hand/]]));
    for (const viewer of ['P2', 'P3', 'P4']) {
      const view = buildPlayerView(ctx, viewer);
      const revealed = view.recentLog.find((line) => line.includes('searchFound'));
      expect(revealed, viewer).toContain('name=Forest');
      expect(revealed, viewer).toContain('revealed=true');
      expect(JSON.stringify(view), viewer).not.toContain('Attune Private Secret');
    }
    const narrated = formatPlayerLog(ctx.state.eventLog, 'P2').map((line) => line.text);
    expect(narrated).toContain('reveals Forest');
  });

  it('attune-with-aether-find-nothing — may find nothing yet still shuffles and gives {E}{E}', () => {
    const { ctx } = castAttune('attune-nothing');
    const { decisions } = resolveTop(ctx, answers([[/search your library/, /Find nothing/]]));
    const p1 = playerById(ctx, 'P1');
    expect(decisions.some((d) => d.options.some((o) => o.description === 'Find nothing'))).toBe(
      true,
    );
    expect(p1.hand.some((card) => card.name === 'Forest')).toBe(false);
    expect(p1.energy).toBe(2);
    expect(ctx.state.eventLog.some((event) => event.type === 'searchFound')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('attune-with-aether-basic-only — a nonbasic land is never offered', () => {
    const { ctx } = castAttune('attune-basic-only');
    conjure(ctx, 'P1', NONBASIC(), 'library');
    const { decisions } = resolveTop(ctx, answers([[/search your library/, /Find nothing/]]));
    const search = decisions.find((decision) => /search your library/.test(decision.prompt))!;
    expect(search.options.map((option) => option.description)).not.toContain(
      'Put Attune Nonbasic Land into your hand',
    );
  });

  it('attune-with-aether-unrevealed-search-stays-private — a search without reveal still hides the found card', () => {
    const ctx = pod('attune-unrevealed-regression');
    pump(
      executeAbility(
        ctx,
        { cardId: 'tutor', oracleId: 'tutor', name: 'Private Tutor', controllerId: 'P1' },
        spellAbilityOf([
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofType('Land')),
            destinations: [{ zone: 'hand' }],
            allowFailToFind: true,
          },
        ]),
        [],
      ),
      answers([[/search your library/, /Put Forest into your hand/]]),
    );
    const found = buildPlayerView(ctx, 'P2').recentLog.find((line) => line.includes('searchFound'));
    expect(found).toBeDefined();
    expect(found).not.toContain('Forest');
    expect(buildPlayerView(ctx, 'P1').recentLog.join('\n')).toContain('name=Forest');
    expect(formatPlayerLog(ctx.state.eventLog, 'P2').map((line) => line.text)).not.toContain(
      'reveals Forest',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 1.03 Beacon of Unrest
// ---------------------------------------------------------------------------------------------

describe('Beacon of Unrest', () => {
  const beacon = pinned('Beacon of Unrest');
  const RELIC = () =>
    oracle({ name: 'Beacon Relic', typeLine: 'Artifact', manaCost: '{2}', oracleText: '' });
  const CHARM = () =>
    oracle({ name: 'Beacon Charm', typeLine: 'Enchantment', manaCost: '{1}', oracleText: '' });

  function setup(seed: string) {
    const ctx = pod(seed);
    const card = conjure(ctx, 'P1', beacon.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'B' },
      { symbol: 'B' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    return { ctx, card };
  }

  function cast(ctx: GameContext, objectId: string, targetId: string) {
    const option = castOptionFor(ctx, 'P1', objectId);
    expect(option).toBeDefined();
    expect(option!.targets?.[0]?.options).toContain(targetId);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, targetId]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
  }

  it('beacon-of-unrest-pinned-oracle-supported — pins the Oracle and models both sentences', () => {
    expect(beacon.sha256).toBe('e8e9347132f2e3a9e1529d4ac633e47efaa45a78780e6efb21226d155a7c58d4');
    expect(beacon.card.oracleText).toBe(
      "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle Beacon of Unrest into its owner's library.",
    );
    const def = interpretCard(beacon.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'graveyardToBattlefield', target: 0 },
      { op: 'resolvingSpellShuffleIntoLibrary' },
    ]);
  });

  it("beacon-of-unrest-reanimate-opponent-creature — returns an opponent's creature card under your control", () => {
    const { ctx, card } = setup('beacon-opponent-creature');
    const victim = conjure(ctx, 'P2', bear(), 'graveyard');
    cast(ctx, card.id, victim.id);
    resolveTop(ctx);
    const returned = ctx.state.battlefield.find((entry) => entry.cardId === victim.cardId);
    expect(returned?.controllerId).toBe('P1');
    expect(returned?.ownerId).toBe('P2');
    expect(playerById(ctx, 'P2').graveyard).toEqual([]);
  });

  it("beacon-of-unrest-shuffles-itself — the resolving Beacon goes into its owner's library, then that library is shuffled", () => {
    const { ctx, card } = setup('beacon-shuffle-self');
    const relic = conjure(ctx, 'P1', RELIC(), 'graveyard');
    const libraryBefore = playerById(ctx, 'P1').library.length;
    cast(ctx, card.id, relic.id);
    resolveTop(ctx);
    const p1 = playerById(ctx, 'P1');
    expect(ctx.state.battlefield.some((entry) => entry.cardId === relic.cardId)).toBe(true);
    expect(p1.graveyard.some((entry) => entry.cardId === card.cardId)).toBe(false);
    expect(p1.library.some((entry) => entry.cardId === card.cardId)).toBe(true);
    expect(p1.library).toHaveLength(libraryBefore + 1);
    const types = ctx.state.eventLog.map((event) => event.type);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(
      types.lastIndexOf('graveyardToBattlefield'),
    );
    expect(ctx.state.stack).toHaveLength(0);
  });

  it("beacon-of-unrest-owner-library — a Beacon owned by another player shuffles into that player's library", () => {
    const { ctx, card } = setup('beacon-owner');
    card.ownerId = 'P2';
    const relic = conjure(ctx, 'P1', RELIC(), 'graveyard');
    cast(ctx, card.id, relic.id);
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').library.some((entry) => entry.cardId === card.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').library.some((entry) => entry.cardId === card.cardId)).toBe(false);
  });

  it('beacon-of-unrest-target-filter — only artifact and creature cards in graveyards are targets', () => {
    const { ctx, card } = setup('beacon-filter');
    const creature = conjure(ctx, 'P3', bear(), 'graveyard');
    const relic = conjure(ctx, 'P2', RELIC(), 'graveyard');
    const charm = conjure(ctx, 'P1', CHARM(), 'graveyard');
    const land = conjure(ctx, 'P1', forest(), 'graveyard');
    const onBattlefield = spawn(ctx, 'P2', bear());
    const offered = castOptionFor(ctx, 'P1', card.id)!.targets![0]!.options;
    expect(offered).toEqual(expect.arrayContaining([creature.id, relic.id]));
    expect(offered).not.toContain(charm.id);
    expect(offered).not.toContain(land.id);
    expect(offered).not.toContain(onBattlefield.id);
  });

  it('beacon-of-unrest-no-target-not-castable — with no artifact or creature card in any graveyard it cannot be cast', () => {
    const { ctx, card } = setup('beacon-no-target');
    conjure(ctx, 'P1', CHARM(), 'graveyard');
    expect(castOptionFor(ctx, 'P1', card.id)).toBeUndefined();
  });

  it('beacon-of-unrest-fizzle-to-graveyard — an illegal target fizzles; Beacon goes to the graveyard and is not shuffled', () => {
    const { ctx, card } = setup('beacon-fizzle');
    const victim = conjure(ctx, 'P2', bear(), 'graveyard');
    cast(ctx, card.id, victim.id);
    // The target leaves the graveyard before resolution (CR 608.2b).
    const p2 = playerById(ctx, 'P2');
    p2.graveyard = p2.graveyard.filter((entry) => entry.id !== victim.id);
    victim.zone = 'exile';
    ctx.state.exile.push(victim);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.cardId === victim.cardId)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === card.cardId)).toBe(
      true,
    );
    expect(playerById(ctx, 'P1').library.some((entry) => entry.cardId === card.cardId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.04 Canoptek Spyder
// ---------------------------------------------------------------------------------------------

describe('Canoptek Spyder', () => {
  const spyder = pinned('Canoptek Spyder');
  const cog = () =>
    oracle({ name: 'Spyder Cog', typeLine: 'Artifact Creature — Construct', manaCost: '{2}' });
  const vehicle = () =>
    oracle({ name: 'Spyder Vehicle', typeLine: 'Artifact — Vehicle', manaCost: '{2}' });
  const relic = () => oracle({ name: 'Spyder Relic', typeLine: 'Artifact', manaCost: '{1}' });

  function board(seed: string) {
    const ctx = pod(seed);
    spawn(ctx, 'P1', spyder.card);
    return { ctx, hand: () => playerById(ctx, 'P1').hand.length };
  }

  /** Cards drawn by P1 after `act` once every resulting trigger has resolved. */
  function drawsAfter(ctx: GameContext, act: () => void): number {
    const before = playerById(ctx, 'P1').hand.length;
    act();
    settle(ctx);
    return playerById(ctx, 'P1').hand.length - before;
  }

  it('canoptek-spyder-pinned-oracle-supported — pins the Oracle and models flying plus the draw trigger', () => {
    expect(spyder.sha256).toBe('53b215a10a556d1e72d4f977805f0cb972b18a035e0e0e3e8d4a9e928b9c5e20');
    const def = interpretCard(spyder.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
  });

  it('canoptek-spyder-nontoken-artifact-creature-draws — another nontoken artifact creature you control entering draws a card', () => {
    const { ctx } = board('spyder-cog');
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', cog()))).toBe(1);
  });

  it('canoptek-spyder-vehicle-draws — a noncreature Vehicle you control entering draws a card', () => {
    const { ctx } = board('spyder-vehicle');
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', vehicle()))).toBe(1);
  });

  it('canoptek-spyder-tokens-do-not-draw — artifact creature and Vehicle tokens do not trigger', () => {
    const { ctx } = board('spyder-tokens');
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', cog(), { token: true }))).toBe(0);
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', vehicle(), { token: true }))).toBe(0);
  });

  it("canoptek-spyder-filter-negatives — nonartifact creatures, plain artifacts, opponents' permanents, and itself do not trigger", () => {
    const { ctx } = board('spyder-negatives');
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', bear()))).toBe(0);
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', relic()))).toBe(0);
    expect(drawsAfter(ctx, () => enter(ctx, 'P2', cog()))).toBe(0);
    const fresh = pod('spyder-self');
    expect(drawsAfter(fresh, () => enter(fresh, 'P1', spyder.card))).toBe(0);
  });

  it('canoptek-spyder-two-spyders — each Spyder triggers for another entering Spyder', () => {
    const { ctx } = board('spyder-pair');
    expect(drawsAfter(ctx, () => enter(ctx, 'P1', spyder.card))).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.05 Canoptek Wraith
// ---------------------------------------------------------------------------------------------

describe('Canoptek Wraith', () => {
  const wraith = pinned('Canoptek Wraith');
  const snowForest = () =>
    oracle({
      name: 'Snow-Covered Forest',
      typeLine: 'Basic Snow Land — Forest',
      manaCost: null,
      oracleText: '({T}: Add {G}.)',
    });
  const grove = () =>
    oracle({ name: 'Wraith Grove', typeLine: 'Land', manaCost: null, oracleText: '{T}: Add {G}.' });

  /** P1 controls Wraith plus `lands`; the library holds `library` (top first). */
  function board(seed: string, lands: OracleCard[], library: OracleCard[], mana = 3) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', wraith.card);
    for (const land of lands) spawn(ctx, 'P1', land, { tapped: true });
    playerById(ctx, 'P1').library = [];
    for (const card of [...library].reverse()) conjure(ctx, 'P1', card, 'library');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: mana }, () => ({ symbol: 'C' as const })),
    );
    return { ctx, self };
  }

  function scout(ctx: GameContext, self: EnginePermanent, answer?: Answer) {
    const trigger = interpretCard(wraith.card).triggers[0]!;
    return pump(
      executeAbility(
        ctx,
        { cardId: self.cardId, oracleId: self.oracleId, name: self.name, controllerId: 'P1' },
        trigger,
        [],
      ),
      answer,
    );
  }

  const lands = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1' && entry.name === name);

  it('canoptek-wraith-pinned-oracle-supported — pins the Oracle and models both lines', () => {
    expect(wraith.sha256).toBe('04d5efb7388c9a8185ee2000da27e3c1fe20e8da9a1061abff8f431729d2e4b2');
    const def = interpretCard(wraith.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.trigger).toEqual({
      when: 'dealsCombatDamageToPlayer',
      subject: { kind: 'self' },
    });
  });

  it('canoptek-wraith-cant-be-blocked — Wraith Form makes it unblockable', () => {
    const { ctx, self } = board('wraith-unblockable', [], []);
    expect(computeCharacteristics(ctx, self).cantBeBlocked).toBe(true);
  });

  it('canoptek-wraith-same-name-search — pays {3}, sacrifices, and finds up to two basics named like the chosen land', () => {
    const { ctx, self } = board(
      'wraith-same-name',
      [island(), forest()],
      [forest(), island(), island(), island()],
    );
    const { decisions } = scout(
      ctx,
      self,
      answers([
        [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
        [/choose a land you control/, /Choose Island/],
        [/search your library/, /Put Island onto the battlefield tapped/],
      ]),
    );
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(['Canoptek Wraith']);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(lands(ctx, 'Island')).toHaveLength(3);
    expect(lands(ctx, 'Island').every((land) => land.tapped)).toBe(true);
    const searches = decisions.filter((decision) => /search your library/.test(decision.prompt));
    expect(searches).toHaveLength(2);
    for (const search of searches) {
      expect(search.options.map((option) => option.description)).not.toContain(
        'Put Forest onto the battlefield tapped',
      );
    }
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('canoptek-wraith-up-to-two — may stop after one or find nothing', () => {
    const { ctx, self } = board('wraith-up-to', [forest()], [forest(), forest()]);
    scout(
      ctx,
      self,
      answers([
        [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
        [/search your library/, /Find nothing/],
      ]),
    );
    expect(lands(ctx, 'Forest')).toHaveLength(1);
    expect(playerById(ctx, 'P1').library).toHaveLength(2);
  });

  it('canoptek-wraith-name-not-type — a Snow-Covered Forest choice never finds a plain Forest', () => {
    const { ctx, self } = board('wraith-snow', [snowForest()], [forest(), snowForest()]);
    const { decisions } = scout(
      ctx,
      self,
      answers([
        [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
        [/search your library/, /Put Snow-Covered Forest/],
      ]),
    );
    const searches = decisions.filter((decision) => /search your library/.test(decision.prompt));
    expect(searches[0]?.options.map((option) => option.description)).toEqual([
      'Put Snow-Covered Forest onto the battlefield tapped',
      'Find nothing',
    ]);
    expect(lands(ctx, 'Snow-Covered Forest')).toHaveLength(2);
    expect(lands(ctx, 'Forest')).toHaveLength(0);
  });

  it('canoptek-wraith-nonbasic-choice-finds-nothing — choosing a nonbasic land still sacrifices, then finds nothing', () => {
    const { ctx, self } = board('wraith-nonbasic', [grove()], [forest()]);
    const { decisions } = scout(
      ctx,
      self,
      answers([[/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/]]),
    );
    expect(decisions.some((decision) => /search your library/.test(decision.prompt))).toBe(false);
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(false);
    expect(playerById(ctx, 'P1').library.map((card) => card.name)).toEqual(['Forest']);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('canoptek-wraith-decline — declining keeps the Wraith, the mana, and the library', () => {
    const { ctx, self } = board('wraith-decline', [island()], [island()]);
    scout(ctx, self, answers([[/pay \{3\} and sacrifice/, /Decline/]]));
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(3);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(false);
  });

  it('canoptek-wraith-unpayable — without {3}, or once the Wraith is gone, nothing is offered', () => {
    const poor = board('wraith-poor', [island()], [island()], 2);
    const poorRun = scout(poor.ctx, poor.self);
    expect(poorRun.decisions).toEqual([]);
    expect(poor.ctx.state.battlefield.some((entry) => entry.cardId === poor.self.cardId)).toBe(
      true,
    );

    const gone = board('wraith-gone', [island()], [island()]);
    gone.ctx.state.battlefield = gone.ctx.state.battlefield.filter(
      (entry) => entry.cardId !== gone.self.cardId,
    );
    expect(scout(gone.ctx, gone.self).decisions).toEqual([]);
    expect(lands(gone.ctx, 'Island')).toHaveLength(1);
  });

  it('canoptek-wraith-blinked-in-response — a Wraith that left and returned is a new object the trigger cannot sacrifice', () => {
    const { ctx, self } = board('wraith-blink', [island()], [island(), island()]);
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: self.cardId,
      sourceOracleId: self.oracleId,
      sourceName: self.name,
      ability: interpretCard(wraith.card).triggers[0]!,
    });
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, self, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === self.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    const { decisions } = resolveTop(ctx, answers([[/pay \{3\} and sacrifice/, /Pay \{3\}/]]));
    expect(decisions.some((decision) => /pay \{3\} and sacrifice/.test(decision.prompt))).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(3);
    expect(lands(ctx, 'Island')).toHaveLength(1);
  });

  describe('paying {3} with a sacrifice-a-creature mana ability', () => {
    const altar = () =>
      oracle({
        name: 'Wraith Altar',
        typeLine: 'Artifact',
        manaCost: '{3}',
        oracleText: 'Sacrifice a creature: Add {C}{C}.',
      });

    it('canoptek-wraith-reserved-from-mana-sacrifice — the Altar may not sacrifice the Wraith it is paying for', () => {
      const { ctx, self } = board('wraith-altar-alone', [island()], [island()], 1);
      const shrine = spawn(ctx, 'P1', altar());
      expect(manaSourcesFor(ctx, 'P1').some((source) => source.cardId === shrine.cardId)).toBe(
        true,
      );
      // The Wraith is the only creature: {2} from the Altar would need to sacrifice it, which
      // the "and sacrifice it" half then cannot pay, so the whole cost is unpayable.
      expect(scout(ctx, self).decisions).toEqual([]);
      expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
      expect(playerById(ctx, 'P1').graveyard).toEqual([]);
    });

    it('canoptek-wraith-altar-sacrifices-another — with another creature, the Altar sacrifices that one and the Wraith is sacrificed by its own cost', () => {
      const { ctx, self } = board('wraith-altar-other', [island()], [island(), island()], 1);
      spawn(ctx, 'P1', altar());
      spawn(ctx, 'P1', bear());
      const { decisions } = scout(
        ctx,
        self,
        answers([
          [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
          [/search your library/, /Put Island onto the battlefield tapped/],
        ]),
      );
      // Never offered the Wraith as the Altar's sacrifice (the Bear is the only candidate left).
      expect(
        decisions.some((decision) =>
          decision.options.some((option) => option.description === 'Sacrifice Canoptek Wraith'),
        ),
      ).toBe(false);
      expect(
        playerById(ctx, 'P1')
          .graveyard.map((card) => card.name)
          .sort(),
      ).toEqual(['Canoptek Wraith', 'Test Bear']);
      expect(lands(ctx, 'Island').length).toBeGreaterThan(1);
    });

    it('canoptek-wraith-altars-share-one-creature — two Altars cannot both sacrifice the one other creature', () => {
      // {3} needs both Altars ({C}{C} each, no floating mana), which needs two creatures besides
      // the Wraith; there is only the Bear, so the cost is unpayable and nothing is offered.
      const { ctx, self } = board('wraith-two-altars', [island()], [island()], 0);
      spawn(ctx, 'P1', altar());
      spawn(ctx, 'P1', altar());
      const victim = spawn(ctx, 'P1', bear());
      expect(scout(ctx, self).decisions).toEqual([]);
      expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(true);
      expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
    });

    const birds = () =>
      oracle({
        name: 'Wraith Birds',
        typeLine: 'Creature — Bird',
        oracleText: '{T}: Add {G}.',
        power: '0',
        toughness: '1',
      });

    it("canoptek-wraith-altar-and-mana-creature — Birds taps for mana first, then may be the Altar's sacrifice", () => {
      // {3} = {G} from the Birds + {C}{C} from the Altar, whose only fodder besides the Wraith is
      // the Birds. Legal: tap the Birds for mana, then sacrifice it. The payment must not try to
      // tap the Birds after sacrificing it.
      const { ctx, self } = board('wraith-altar-birds', [island()], [island()], 0);
      spawn(ctx, 'P1', altar());
      const mana = spawn(ctx, 'P1', birds());
      mana.summoningSick = false;
      const { decisions } = scout(
        ctx,
        self,
        answers([
          [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
          [/to sacrifice/, /Sacrifice Wraith Birds/],
          [/search your library/, /Put Island onto the battlefield tapped/],
        ]),
      );
      expect(decisions.some((decision) => /pay \{3\} and sacrifice/.test(decision.prompt))).toBe(
        true,
      );
      expect(
        playerById(ctx, 'P1')
          .graveyard.map((card) => card.name)
          .sort(),
      ).toEqual(['Canoptek Wraith', 'Wraith Birds']);
      expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    });

    it('canoptek-wraith-tower-and-altar — Phyrexian Tower makes {C} while the Altar sacrifices the one other creature', () => {
      // Tower's own sacrifice ability would want the Bear too; using Tower's plain {C} and the
      // Altar's {C}{C} instead is a legal way to pay {3}, so it must be offered.
      const { ctx, self } = board('wraith-tower-altar', [], [island()], 0);
      spawn(
        ctx,
        'P1',
        oracle({
          name: 'Wraith Tower',
          typeLine: 'Legendary Land',
          manaCost: null,
          oracleText: '{T}: Add {C}.\n{T}, Sacrifice a creature: Add {B}{B}.',
        }),
      );
      spawn(ctx, 'P1', altar());
      spawn(ctx, 'P1', bear());
      const { decisions } = scout(
        ctx,
        self,
        answers([[/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/]]),
      );
      expect(decisions.some((decision) => /pay \{3\} and sacrifice/.test(decision.prompt))).toBe(
        true,
      );
      expect(
        playerById(ctx, 'P1')
          .graveyard.map((card) => card.name)
          .sort(),
      ).toEqual(['Canoptek Wraith', 'Test Bear']);
      expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    });

    it("canoptek-wraith-altar-sacrifices-unused-spawn — an Eldrazi Spawn whose own mana is not needed may be the Altar's fodder", () => {
      // {3} = {C} from a land + {C}{C} from the Altar sacrificing the Spawn. Keeping the Spawn as
      // a mana source instead would leave the Altar no fodder and only {2}.
      const { ctx, self } = board('wraith-altar-spawn', [], [island()], 0);
      spawn(
        ctx,
        'P1',
        oracle({
          name: 'Wraith Waste',
          typeLine: 'Land',
          manaCost: null,
          oracleText: '{T}: Add {C}.',
        }),
      );
      spawn(ctx, 'P1', altar());
      const spawnling = spawn(
        ctx,
        'P1',
        oracle({
          name: 'Wraith Spawn',
          typeLine: 'Creature — Eldrazi Spawn',
          oracleText: 'Sacrifice this creature: Add {C}.',
          power: '0',
          toughness: '1',
        }),
      );
      expect(manaSourcesFor(ctx, 'P1').some((source) => source.cardId === spawnling.cardId)).toBe(
        true,
      );
      const { decisions } = scout(
        ctx,
        self,
        answers([[/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/]]),
      );
      expect(decisions.some((decision) => /pay \{3\} and sacrifice/.test(decision.prompt))).toBe(
        true,
      );
      expect(
        playerById(ctx, 'P1')
          .graveyard.map((card) => card.name)
          .sort(),
      ).toEqual(['Canoptek Wraith', 'Wraith Spawn']);
      expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    });

    it("canoptek-wraith-two-altars-either-order — with one floating mana, Ashnod's Altar pays whichever altar comes first", () => {
      // {3} = one floating {C} + Ashnod's {C}{C}; Phyrexian Altar would make only one. Both
      // altars want the same lone creature, so legality must not depend on battlefield order.
      const phyrexian = () =>
        oracle({
          name: 'Wraith Phyrexian Altar',
          typeLine: 'Artifact',
          manaCost: '{3}',
          oracleText: 'Sacrifice a creature: Add one mana of any color.',
        });
      for (const order of ['phyrexian-first', 'ashnod-first'] as const) {
        const { ctx, self } = board(`wraith-altar-order-${order}`, [], [island()], 1);
        if (order === 'phyrexian-first') {
          spawn(ctx, 'P1', phyrexian());
          spawn(ctx, 'P1', altar());
        } else {
          spawn(ctx, 'P1', altar());
          spawn(ctx, 'P1', phyrexian());
        }
        spawn(ctx, 'P1', bear());
        const { decisions } = scout(
          ctx,
          self,
          answers([[/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/]]),
        );
        expect(
          decisions.some((decision) => /pay \{3\} and sacrifice/.test(decision.prompt)),
          order,
        ).toBe(true);
        expect(
          playerById(ctx, 'P1')
            .graveyard.map((card) => card.name)
            .sort(),
          order,
        ).toEqual(['Canoptek Wraith', 'Test Bear']);
      }
    });

    it('canoptek-wraith-altars-two-creatures — with two other creatures both Altars pay, each sacrificing a different one', () => {
      const { ctx, self } = board('wraith-two-altars-ok', [island()], [island()], 0);
      spawn(ctx, 'P1', altar());
      spawn(ctx, 'P1', altar());
      spawn(ctx, 'P1', bear());
      spawn(
        ctx,
        'P1',
        oracle({ name: 'Altar Fodder', typeLine: 'Creature — Elf', power: '1', toughness: '1' }),
      );
      const { decisions } = scout(
        ctx,
        self,
        answers([
          [/pay \{3\} and sacrifice/, /Pay \{3\} and sacrifice/],
          [/search your library/, /Put Island onto the battlefield tapped/],
        ]),
      );
      expect(
        decisions.some((decision) =>
          decision.options.some((option) => option.description === 'Sacrifice Canoptek Wraith'),
        ),
      ).toBe(false);
      expect(
        playerById(ctx, 'P1')
          .graveyard.map((card) => card.name)
          .sort(),
      ).toEqual(['Altar Fodder', 'Canoptek Wraith', 'Test Bear']);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 1.06 Conjurer's Closet
// ---------------------------------------------------------------------------------------------

describe("Conjurer's Closet", () => {
  const closet = pinned("Conjurer's Closet");
  const greeter = () =>
    oracle({
      name: 'Closet Greeter',
      typeLine: 'Creature — Human',
      oracleText: 'When this creature enters, you gain 2 life.',
    });

  function endStep(ctx: GameContext, active = 'P1') {
    ctx.state.currentTurnPlayer = active;
    ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(active);
    ctx.state.phase = 'ending';
    ctx.state.step = 'end';
    queueStepTriggers(ctx, 'endStep');
  }

  /** Answer the Closet's target choice (when asked) and its yes/no resolution decision. */
  function closetAnswer(targetId: string | null, accept: boolean): Answer {
    return (decision) => {
      if (decision.decisionType === 'optionalTrigger') {
        return optionMatching(decision, accept ? /^Yes$/ : /^No$/);
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined && targetId !== null) {
        return { index: 0, targets: new Map([[slot.slot, targetId]]) };
      }
      return { index: 0, targets: new Map() };
    };
  }

  it('conjurers-closet-pinned-oracle-supported — pins the Oracle and models the optional targeted blink', () => {
    expect(closet.sha256).toBe('d80cdb0f2c13939c9ac36f2137931ba2cd340fb6e524f8906c038be6c7818b2c');
    const def = interpretCard(closet.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]).toMatchObject({
      optional: true,
      trigger: { when: 'endStep', player: 'you' },
      targets: [{ kind: 'creature', controller: 'you' }],
      effects: [{ op: 'blinkTarget', target: 0 }],
    });
  });

  it('conjurers-closet-blink-resets-and-reenters — the creature returns as a new untapped object under your control and its ETB triggers', () => {
    const ctx = pod('closet-blink');
    spawn(ctx, 'P1', closet.card);
    const creature = spawn(ctx, 'P1', greeter(), { tapped: true });
    creature.counters['+1/+1'] = 2;
    creature.damageMarked = 1;
    const lifeBefore = playerById(ctx, 'P1').life;
    endStep(ctx);
    settle(ctx, closetAnswer(creature.id, true));
    const returned = ctx.state.battlefield.find((entry) => entry.cardId === creature.cardId);
    expect(returned).toBeDefined();
    expect(returned!.id).not.toBe(creature.id);
    expect(returned!.controllerId).toBe('P1');
    expect(returned!.tapped).toBe(false);
    expect(returned!.counters['+1/+1'] ?? 0).toBe(0);
    expect(returned!.damageMarked).toBe(0);
    expect(playerById(ctx, 'P1').life).toBe(lifeBefore + 2);
  });

  it('conjurers-closet-chooses-among-own-creatures — only creatures you control are offered, and the chosen one blinks', () => {
    const ctx = pod('closet-choice');
    spawn(ctx, 'P1', closet.card);
    const first = spawn(ctx, 'P1', bear());
    const second = spawn(ctx, 'P1', greeter(), { tapped: true });
    const theirs = spawn(ctx, 'P2', bear());
    endStep(ctx);
    const { decisions } = settle(ctx, closetAnswer(second.id, true));
    const offered = decisions.flatMap(
      (decision) => decision.options[0]?.targets?.[0]?.options ?? [],
    );
    expect(offered).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(offered).not.toContain(theirs.id);
    expect(ctx.state.battlefield.find((entry) => entry.id === first.id)).toBeDefined();
    expect(ctx.state.battlefield.find((entry) => entry.cardId === second.cardId)?.tapped).toBe(
      false,
    );
  });

  it('conjurers-closet-decline — answering no leaves the creature untouched', () => {
    const ctx = pod('closet-decline');
    spawn(ctx, 'P1', closet.card);
    const creature = spawn(ctx, 'P1', greeter(), { tapped: true });
    endStep(ctx);
    const lifeBefore = playerById(ctx, 'P1').life;
    settle(ctx, closetAnswer(creature.id, false));
    expect(ctx.state.battlefield.find((entry) => entry.id === creature.id)?.tapped).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(lifeBefore);
    expect(ctx.state.eventLog.some((event) => event.type === 'triggerDeclined')).toBe(true);
  });

  it("conjurers-closet-no-target-or-other-turn — nothing resolves without a creature you control or on another player's end step", () => {
    const empty = pod('closet-empty');
    spawn(empty, 'P1', closet.card);
    const theirs = spawn(empty, 'P2', bear(), { tapped: true });
    endStep(empty);
    const emptyRun = settle(empty);
    expect(emptyRun.decisions.some((d) => d.decisionType === 'optionalTrigger')).toBe(false);
    expect(empty.state.battlefield.find((entry) => entry.id === theirs.id)?.tapped).toBe(true);

    const other = pod('closet-other-turn');
    spawn(other, 'P1', closet.card);
    const mine = spawn(other, 'P1', bear(), { tapped: true });
    endStep(other, 'P2');
    expect(other.state.pendingTriggers).toHaveLength(0);
    settle(other);
    expect(other.state.battlefield.find((entry) => entry.id === mine.id)?.tapped).toBe(true);
  });

  it('conjurers-closet-token-does-not-return — an exiled token ceases to exist instead of returning', () => {
    const ctx = pod('closet-token');
    spawn(ctx, 'P1', closet.card);
    const token = spawn(ctx, 'P1', bear(), { isToken: true });
    endStep(ctx);
    settle(ctx, closetAnswer(token.id, true));
    expect(ctx.state.battlefield.some((entry) => entry.cardId === token.cardId)).toBe(false);
  });

  it('conjurers-closet-illegal-target-fizzles — a target that left before resolution is not returned', () => {
    const ctx = pod('closet-fizzle');
    spawn(ctx, 'P1', closet.card);
    const creature = spawn(ctx, 'P1', bear());
    endStep(ctx);
    pump(priorityCheckpoint(ctx), closetAnswer(creature.id, true));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, creature, { zone: 'graveyard' }));
    const { decisions } = resolveTop(ctx, closetAnswer(null, true));
    // All its targets are illegal, so it is removed without the "you may" choice (CR 608.2b).
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.cardId === creature.cardId)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === creature.cardId)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 1.07 Harvest Season
// ---------------------------------------------------------------------------------------------

describe('Harvest Season', () => {
  const harvest = pinned('Harvest Season');

  /** P1 casts Harvest Season with the given creatures on board; library holds `library`. */
  function cast(seed: string, setup: (ctx: GameContext) => void, library: OracleCard[]) {
    const ctx = pod(seed);
    setup(ctx);
    playerById(ctx, 'P1').library = [];
    for (const card of [...library].reverse()) conjure(ctx, 'P1', card, 'library');
    const inHand = conjure(ctx, 'P1', harvest.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'C' }, { symbol: 'C' }]);
    const option = castOptionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    return ctx;
  }

  const searches = (decisions: PendingDecision[]) =>
    decisions.filter((decision) => /search your library/.test(decision.prompt));
  const forests = (ctx: GameContext) =>
    ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1' && entry.name === 'Forest');

  it('harvest-season-pinned-oracle-supported — pins the Oracle and counts tapped creatures', () => {
    expect(harvest.sha256).toBe('3f013020bdf1351d15c88eff85e1030be7f07537aff30256a911ba95125b7c9f');
    const def = interpretCard(harvest.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects[0]).toMatchObject({
      op: 'searchLibrary',
      count: { kind: 'countTappedPermanents', selector: { kind: 'type', value: 'Creature' } },
      destinations: [{ zone: 'battlefield', tapped: true }],
    });
  });

  it('harvest-season-x-is-tapped-creatures — only your tapped creatures count toward X', () => {
    const ctx = cast(
      'harvest-tapped',
      (c) => {
        spawn(c, 'P1', bear(), { tapped: true });
        spawn(c, 'P1', bear(), { tapped: true });
        spawn(c, 'P1', bear());
        spawn(c, 'P1', island(), { tapped: true });
        spawn(c, 'P2', bear(), { tapped: true });
      },
      [forest(), forest(), forest(), forest()],
    );
    const { decisions } = resolveTop(ctx, answers([[/search your library/, /Put Forest/]]));
    expect(searches(decisions)).toHaveLength(2);
    expect(forests(ctx)).toHaveLength(2);
    expect(forests(ctx).every((land) => land.tapped)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('harvest-season-zero-tapped — with no tapped creatures nothing is searched, but the library is shuffled', () => {
    const ctx = cast('harvest-zero', (c) => void spawn(c, 'P1', bear()), [forest(), forest()]);
    const { decisions } = resolveTop(ctx);
    expect(searches(decisions)).toEqual([]);
    expect(forests(ctx)).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('harvest-season-up-to — may find fewer than X, and only basic lands are offered', () => {
    const nonbasic = oracle({ name: 'Harvest Grove', typeLine: 'Land', manaCost: null });
    const ctx = cast(
      'harvest-up-to',
      (c) => {
        for (let i = 0; i < 3; i++) spawn(c, 'P1', bear(), { tapped: true });
      },
      [nonbasic, forest(), forest()],
    );
    const { decisions } = resolveTop(ctx, (decision, count) =>
      /search your library/.test(decision.prompt) && count === 1
        ? optionMatching(decision, /Put Forest/)
        : optionMatching(decision, /Find nothing/),
    );
    expect(searches(decisions)[0]!.options.map((option) => option.description)).not.toContain(
      'Put Harvest Grove onto the battlefield tapped',
    );
    expect(forests(ctx)).toHaveLength(1);
  });

  it('harvest-season-tapped-at-resolution — X is counted when the spell resolves', () => {
    const ctx = cast('harvest-resolution', (c) => void spawn(c, 'P1', bear(), { tapped: true }), [
      forest(),
      forest(),
      forest(),
    ]);
    // A second creature becomes tapped while Harvest Season is on the stack.
    spawn(ctx, 'P1', bear(), { tapped: true });
    const { decisions } = resolveTop(ctx, answers([[/search your library/, /Put Forest/]]));
    expect(searches(decisions)).toHaveLength(2);
    expect(forests(ctx)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.08 Land Tax
// ---------------------------------------------------------------------------------------------

describe('Land Tax', () => {
  const tax = pinned('Land Tax');

  /** P1 has Land Tax and `mine` lands; P2..P4 have the given land counts. */
  function board(seed: string, mine: number, others: [number, number, number], library = 5) {
    const ctx = pod(seed);
    spawn(ctx, 'P1', tax.card);
    for (let i = 0; i < mine; i++) spawn(ctx, 'P1', island());
    (['P2', 'P3', 'P4'] as const).forEach((id, index) => {
      for (let i = 0; i < others[index]!; i++) spawn(ctx, id, forest());
    });
    playerById(ctx, 'P1').library = [];
    conjure(ctx, 'P1', SECRET('Land Tax Private Secret'), 'library');
    for (let i = 0; i < library; i++)
      conjure(ctx, 'P1', i % 2 === 0 ? plains() : swamp(), 'library');
    return ctx;
  }

  function upkeep(ctx: GameContext, active = 'P1') {
    ctx.state.currentTurnPlayer = active;
    ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(active);
    ctx.state.phase = 'beginning';
    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
  }

  const taxAnswer =
    (accept: boolean): Answer =>
    (decision) =>
      decision.decisionType === 'optionalTrigger'
        ? optionMatching(decision, accept ? /^Yes$/ : /^No$/)
        : /search your library/.test(decision.prompt)
          ? optionMatching(decision, /Put (Plains|Swamp) into your hand/)
          : { index: 0, targets: new Map() };

  const searches = (decisions: PendingDecision[]) =>
    decisions.filter((decision) => /search your library/.test(decision.prompt));

  it('land-tax-pinned-oracle-supported — pins the Oracle and models the conditional optional search', () => {
    expect(tax.sha256).toBe('4b365fab95d5ae332e404759f054d57169911d769d44ef0cbf6890e83ac0d4a7');
    const def = interpretCard(tax.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]).toMatchObject({
      optional: true,
      trigger: {
        when: 'upkeep',
        player: 'you',
        condition: { kind: 'opponentControlsMore' },
      },
    });
  });

  it('land-tax-search-reveal-three — finds up to three basics, reveals them, puts them into hand, and shuffles', () => {
    const ctx = board('tax-search', 2, [3, 0, 0]);
    upkeep(ctx);
    const handBefore = playerById(ctx, 'P1').hand.length;
    const { decisions } = settle(ctx, taxAnswer(true));
    expect(searches(decisions)).toHaveLength(3);
    const hand = playerById(ctx, 'P1').hand;
    expect(hand).toHaveLength(handBefore + 3);
    expect(hand.every((card) => ['Plains', 'Swamp'].includes(card.name))).toBe(true);
    const revealed = ctx.state.eventLog.filter((event) => event.type === 'searchFound');
    expect(revealed).toHaveLength(3);
    expect(revealed.every((event) => event.payload['revealed'] === true)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    const opponentLog = buildPlayerView(ctx, 'P2').recentLog.join('\n');
    expect(opponentLog).toContain('revealed=true');
    expect(opponentLog).not.toContain('Land Tax Private Secret');
  });

  it('land-tax-per-opponent-comparison — no trigger when no single opponent has more lands, even if they do combined', () => {
    const ctx = board('tax-per-opponent', 3, [3, 2, 3]);
    upkeep(ctx);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    const { decisions } = settle(ctx, taxAnswer(true));
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
  });

  it('land-tax-rechecked-on-resolution — the intervening if is checked again as it resolves', () => {
    const ctx = board('tax-recheck', 2, [3, 0, 0]);
    upkeep(ctx);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    spawn(ctx, 'P1', island());
    const { decisions } = resolveTop(ctx, taxAnswer(true));
    expect(searches(decisions)).toEqual([]);
    expect(playerById(ctx, 'P1').hand).toHaveLength(0);
  });

  it('land-tax-decline — declining searches nothing and does not shuffle', () => {
    const ctx = board('tax-decline', 1, [2, 0, 0]);
    upkeep(ctx);
    const { decisions } = settle(ctx, taxAnswer(false));
    expect(searches(decisions)).toEqual([]);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(false);
  });

  it("land-tax-only-your-upkeep — does not trigger on an opponent's upkeep", () => {
    const ctx = board('tax-other-upkeep', 1, [5, 0, 0]);
    upkeep(ctx, 'P2');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('land-tax-fewer-basics — may find fewer, and nonbasic lands are never offered', () => {
    const ctx = board('tax-fewer', 1, [2, 0, 0], 1);
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Tax Nonbasic', typeLine: 'Land', manaCost: null }),
      'library',
    );
    upkeep(ctx);
    const { decisions } = settle(ctx, taxAnswer(true));
    expect(searches(decisions)).toHaveLength(1);
    expect(searches(decisions)[0]!.options.map((option) => option.description)).not.toContain(
      'Put Tax Nonbasic into your hand',
    );
    expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Plains']);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.09 Mordant Dragon
// ---------------------------------------------------------------------------------------------

/**
 * Run this turn's combat phase through the production combat code: each attacker in `attacks`
 * attacks its mapped defender, nobody blocks, and other decisions go to `answer`.
 */
function runCombat(ctx: GameContext, attacks: Record<string, string>, answer?: Answer) {
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return pump(runCombatAndExtraCombats(ctx), (decision, count) => {
    if (decision.presentationAttackDeclaration !== undefined) {
      return declareAttacks(decision, (subjectId) => attacks[subjectId] ?? null);
    }
    if (decision.presentationBlockDeclaration !== undefined) return declareNoBlocks(decision);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

describe('Mordant Dragon', () => {
  const dragon = pinned('Mordant Dragon');
  const ox = () =>
    oracle({ name: 'Mordant Ox', typeLine: 'Creature — Ox', power: '5', toughness: '5' });
  const big = () =>
    oracle({ name: 'Mordant Wall', typeLine: 'Creature — Wall', power: '0', toughness: '9' });

  /** Answer the Dragon's target (when asked) and its yes/no resolution decision. */
  const dragonAnswer =
    (targetId: string | null, accept: boolean): Answer =>
    (decision) => {
      if (decision.decisionType === 'optionalTrigger') {
        return optionMatching(decision, accept ? /^Yes$/ : /^No$/);
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined && targetId !== null) {
        return { index: 0, targets: new Map([[slot.slot, targetId]]) };
      }
      return { index: 0, targets: new Map() };
    };

  const life = (ctx: GameContext, id: string) => playerById(ctx, id).life;

  it('mordant-dragon-pinned-oracle-supported — pins the Oracle and models flying plus the optional targeted rider', () => {
    expect(dragon.sha256).toBe('5f4a39ae0545bf5d50bac488bb58ac3101bb6ac10eeb19f289e2159a39d40552');
    const def = interpretCard(dragon.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.triggers[0]).toMatchObject({
      optional: true,
      trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
      targets: [{ kind: 'creature', controller: 'eventPlayer' }],
      effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'damageDealt' } }],
    });
  });

  it("mordant-dragon-redirects-that-much — after hitting a player it may deal that much damage to that player's creature", () => {
    const ctx = pod('mordant-accept');
    const self = spawn(ctx, 'P1', dragon.card);
    const victim = spawn(ctx, 'P2', ox());
    const power = computeCharacteristics(ctx, self).power;
    const before = life(ctx, 'P2');
    runCombat(ctx, { [self.id]: 'P2' }, dragonAnswer(victim.id, true));
    expect(life(ctx, 'P2')).toBe(before - power);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
    const hit = ctx.state.eventLog.filter(
      (event) => event.type === 'damage' && event.payload['target'] === 'Mordant Ox',
    );
    expect(hit).toHaveLength(1);
    // The Dragon itself is the damage source ("have it deal").
    expect(hit[0]!.payload).toMatchObject({ sourceCardId: self.cardId, amount: power });
  });

  it('mordant-dragon-amount-is-damage-dealt — the rider uses the combat damage actually dealt', () => {
    const ctx = pod('mordant-amount');
    const self = spawn(ctx, 'P1', dragon.card);
    self.counters['+1/+1'] = 2;
    const wall = spawn(ctx, 'P2', big());
    const power = computeCharacteristics(ctx, self).power;
    runCombat(ctx, { [self.id]: 'P2' }, dragonAnswer(wall.id, true));
    expect(ctx.state.battlefield.find((entry) => entry.id === wall.id)?.damageMarked).toBe(power);
  });

  it('mordant-dragon-last-known-deathtouch — a Dragon that had deathtouch and then left still deals deathtouch damage', () => {
    const ctx = pod('mordant-lki');
    const self = spawn(ctx, 'P1', dragon.card);
    ctx.state.effects.push({
      id: 'eff-test-deathtouch',
      sourceId: self.cardId,
      description: 'Mordant Dragon gains deathtouch',
      targetCardIds: [self.cardId],
      kind: 'grantKeyword',
      keyword: 'deathtouch',
      timestamp: ctx.state.nextTimestamp++,
    });
    const wall = spawn(ctx, 'P2', big());
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: self.cardId,
      sourceOracleId: self.oracleId,
      sourceName: self.name,
      ability: interpretCard(dragon.card).triggers[0]!,
      scope: { damageDealt: 1, eventPlayerId: 'P2' },
    });
    pump(priorityCheckpoint(ctx), dragonAnswer(wall.id, true));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    resolveTop(ctx, dragonAnswer(null, true));
    // 1 damage from a (last known) deathtouch source destroys the 0/9 wall (CR 113.7a).
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((entry) => entry.id === wall.id)).toBe(false);
  });

  it('mordant-dragon-dies-before-stack — a Dragon removed before its trigger reaches the stack keeps its last known deathtouch', () => {
    const ctx = pod('mordant-lki-pending');
    const self = spawn(ctx, 'P1', dragon.card);
    ctx.state.effects.push({
      id: 'eff-test-deathtouch',
      sourceId: self.cardId,
      description: 'Mordant Dragon gains deathtouch',
      targetCardIds: [self.cardId],
      kind: 'grantKeyword',
      keyword: 'deathtouch',
      timestamp: ctx.state.nextTimestamp++,
    });
    const wall = spawn(ctx, 'P2', big());
    // The combat-damage trigger has fired; state-based actions remove the Dragon (lethal
    // damage from a blocker) before the trigger is put on the stack.
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: self.cardId,
      sourceObjectId: self.id,
      sourceOracleId: self.oracleId,
      sourceName: self.name,
      ability: interpretCard(dragon.card).triggers[0]!,
      scope: { damageDealt: 1, eventPlayerId: 'P2' },
    });
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    pump(priorityCheckpoint(ctx), dragonAnswer(wall.id, true));
    expect(ctx.state.stack).toHaveLength(1);
    resolveTop(ctx, dragonAnswer(null, true));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((entry) => entry.id === wall.id)).toBe(false);
  });

  it('mordant-dragon-lost-deathtouch-before-leaving — deathtouch lost before it left does not apply', () => {
    const ctx = pod('mordant-lki-lost');
    const self = spawn(ctx, 'P1', dragon.card);
    ctx.state.effects.push({
      id: 'eff-test-deathtouch',
      sourceId: self.cardId,
      description: 'Mordant Dragon gains deathtouch',
      targetCardIds: [self.cardId],
      kind: 'grantKeyword',
      keyword: 'deathtouch',
      timestamp: ctx.state.nextTimestamp++,
    });
    const wall = spawn(ctx, 'P2', big());
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: self.cardId,
      sourceOracleId: self.oracleId,
      sourceName: self.name,
      ability: interpretCard(dragon.card).triggers[0]!,
      scope: { damageDealt: 1, eventPlayerId: 'P2' },
    });
    pump(priorityCheckpoint(ctx), dragonAnswer(wall.id, true));
    // In response, the deathtouch grant ends, then the Dragon leaves: its last known
    // information is "no deathtouch" (CR 113.7a), so 1 damage does not destroy the 0/9.
    ctx.state.effects = ctx.state.effects.filter((effect) => effect.id !== 'eff-test-deathtouch');
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    resolveTop(ctx, dragonAnswer(null, true));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.find((entry) => entry.id === wall.id)?.damageMarked).toBe(1);
  });

  it('mordant-dragon-decline — answering no deals no extra damage', () => {
    const ctx = pod('mordant-decline');
    const self = spawn(ctx, 'P1', dragon.card);
    const wall = spawn(ctx, 'P2', big());
    runCombat(ctx, { [self.id]: 'P2' }, dragonAnswer(wall.id, false));
    expect(ctx.state.battlefield.find((entry) => entry.id === wall.id)?.damageMarked).toBe(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'triggerDeclined')).toBe(true);
  });

  it('mordant-dragon-only-that-players-creatures — only creatures the damaged player controls are legal targets', () => {
    const ctx = pod('mordant-targets');
    const self = spawn(ctx, 'P1', dragon.card);
    const theirs = spawn(ctx, 'P2', big());
    const theirOther = spawn(ctx, 'P2', ox());
    const bystander = spawn(ctx, 'P3', big());
    const mine = spawn(ctx, 'P1', big());
    const { decisions } = runCombat(ctx, { [self.id]: 'P2' }, dragonAnswer(theirs.id, true));
    const offered = decisions
      .filter((decision) => decision.presentationAttackDeclaration === undefined)
      .flatMap((decision) => decision.options[0]?.targets?.[0]?.options ?? []);
    expect(offered).toEqual(expect.arrayContaining([theirs.id, theirOther.id]));
    expect(offered).not.toContain(bystander.id);
    expect(offered).not.toContain(mine.id);
  });

  it('mordant-dragon-no-creature-no-trigger — with no creature for that player, nothing is asked', () => {
    const ctx = pod('mordant-empty');
    const self = spawn(ctx, 'P1', dragon.card);
    spawn(ctx, 'P3', big());
    const { decisions } = runCombat(ctx, { [self.id]: 'P2' }, dragonAnswer(null, true));
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
    expect(ctx.state.stack).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.10 Necron Deathmark
// ---------------------------------------------------------------------------------------------

describe('Necron Deathmark', () => {
  const deathmark = pinned('Necron Deathmark');
  const wall = () =>
    oracle({
      name: 'Deathmark Wall',
      typeLine: 'Creature — Wall',
      oracleText: 'Indestructible',
      keywords: ['Indestructible'],
    });

  /** Choose `player` for the mill slot and `creature` (or none) for the up-to-one slot. */
  const deathmarkAnswer =
    (player: string, creature: string | null): Answer =>
    (decision) => {
      if (/choose (a|another) target/.test(decision.prompt)) {
        return creature === null
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${creature}$`));
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, player]]) };
      return { index: 0, targets: new Map() };
    };

  function board(seed: string) {
    const ctx = pod(seed);
    for (const id of ['P1', 'P2']) {
      playerById(ctx, id).library = [];
      for (let i = 0; i < 5; i++) conjure(ctx, id, forest(), 'library');
    }
    return ctx;
  }

  it('necron-deathmark-pinned-oracle-supported — pins the Oracle and models an up-to-one creature slot', () => {
    expect(deathmark.sha256).toBe(
      '9ea0d5feb506abd7f1b877e3898f5a1aa655060699a83b69ca1753ef2eb20ae6',
    );
    const def = interpretCard(deathmark.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flash');
    expect(def.triggers[0]?.targets).toEqual([
      { kind: 'player' },
      { kind: 'creature', count: { min: 0, max: 1 } },
    ]);
  });

  it('necron-deathmark-destroy-and-mill — destroys the chosen creature and the target player mills three', () => {
    const ctx = board('deathmark-both');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', deathmark.card);
    settle(ctx, deathmarkAnswer('P2', 'Test Bear'));
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual([
      'Test Bear',
      'Forest',
      'Forest',
      'Forest',
    ]);
    expect(playerById(ctx, 'P2').library).toHaveLength(2);
  });

  it('necron-deathmark-zero-creatures — choosing no creature still mills the target player', () => {
    const ctx = board('deathmark-none');
    const bystander = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', deathmark.card);
    const { decisions } = settle(ctx, deathmarkAnswer('P2', null));
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description === 'Choose no more targets'),
      ),
    ).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.id === bystander.id)).toBe(true);
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(3);
  });

  it('necron-deathmark-no-creatures-at-all — with no creature on the battlefield it still triggers for the mill', () => {
    const ctx = board('deathmark-empty');
    const self = enter(ctx, 'P1', deathmark.card);
    // Deathmark itself is a creature, so destroy nothing by declining the creature slot.
    settle(ctx, deathmarkAnswer('P1', null));
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').graveyard).toHaveLength(3);
  });

  it('necron-deathmark-indestructible — an indestructible target survives; the mill still happens', () => {
    const ctx = board('deathmark-indestructible');
    const survivor = spawn(ctx, 'P2', wall());
    enter(ctx, 'P1', deathmark.card);
    settle(ctx, deathmarkAnswer('P2', 'Deathmark Wall'));
    expect(ctx.state.battlefield.some((entry) => entry.id === survivor.id)).toBe(true);
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(3);
  });

  it('necron-deathmark-illegal-creature-keeps-mill — if the creature leaves first, the player still mills', () => {
    const ctx = board('deathmark-partial');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', deathmark.card);
    pump(priorityCheckpoint(ctx), deathmarkAnswer('P2', 'Test Bear'));
    expect(ctx.state.stack[0]?.countTargets?.[1]).toEqual([victim.id]);
    pump(moveObject(ctx, victim, { zone: 'exile' }));
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(3);
    expect(playerById(ctx, 'P2').graveyard.every((card) => card.name === 'Forest')).toBe(true);
  });

  it('necron-deathmark-protection-in-response — a creature that gains protection from black is not destroyed', () => {
    const ctx = board('deathmark-protection');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', deathmark.card);
    pump(priorityCheckpoint(ctx), deathmarkAnswer('P2', 'Test Bear'));
    expect(ctx.state.stack[0]?.countTargets?.[1]).toEqual([victim.id]);
    // In response, the creature gains protection from black: no longer a legal target of the
    // black Deathmark's trigger (CR 608.2b), while the player target still is.
    ctx.state.effects.push({
      id: 'eff-test-protection',
      sourceId: victim.cardId,
      description: 'Test Bear gains protection from B',
      targetCardIds: [victim.cardId],
      kind: 'grantProtection',
      protectionFrom: ['B'],
      timestamp: ctx.state.nextTimestamp++,
    });
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(true);
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(3);
    expect(playerById(ctx, 'P2').graveyard.every((card) => card.name === 'Forest')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.11 Plasmancer
// ---------------------------------------------------------------------------------------------

describe('Plasmancer', () => {
  const plasmancer = pinned('Plasmancer');
  const swamp = () =>
    oracle({
      name: 'Swamp',
      typeLine: 'Basic Land — Swamp',
      manaCost: null,
      oracleText: '({T}: Add {B}.)',
    });
  const snowSwamp = () =>
    oracle({
      name: 'Snow-Covered Swamp',
      typeLine: 'Basic Snow Land — Swamp',
      types: ['Land'],
      manaCost: null,
      oracleText: '({T}: Add {B}.)',
    });
  const nonbasicSwamp = () =>
    oracle({
      name: 'Plasma Bog',
      typeLine: 'Land — Swamp Forest',
      manaCost: null,
      oracleText: '({T}: Add {B} or {G}.)',
    });
  const SEARCH = /search your library/;

  /** Cast Plasmancer from P1's hand on the normal path and resolve the creature spell. */
  function castPlasmancer(seed: string) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', plasmancer.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'B' },
      { symbol: 'B' },
      { symbol: 'G' },
      { symbol: 'G' },
    ]);
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    return ctx;
  }

  it('plasmancer-pinned-oracle-supported — pins the Oracle and models flying plus the revealed Swamp search', () => {
    expect(plasmancer.sha256).toBe(
      '0aedfcf7611280dfaf130e91c553dbc2a0bce3d94f087201255ccd6db34ea22e',
    );
    const def = interpretCard(plasmancer.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]).toMatchObject({
      trigger: { when: 'enters', subject: { kind: 'self' } },
      effects: [
        {
          op: 'searchLibrary',
          reveal: true,
          allowFailToFind: true,
          destinations: [{ zone: 'hand' }],
        },
        { op: 'shuffle' },
      ],
    });
  });

  it('plasmancer-cast-reveals-swamp-to-hand — casting it puts a revealed basic Swamp into hand, then shuffles', () => {
    const cast = castPlasmancer('plasmancer-cast');
    const found = conjure(cast, 'P1', swamp(), 'library');
    settle(cast, answers([[SEARCH, /Put Swamp into your hand/]]));
    const p1 = playerById(cast, 'P1');
    expect(cast.state.battlefield.some((entry) => entry.name === 'Plasmancer')).toBe(true);
    expect(p1.hand.map((card) => card.cardId)).toContain(found.cardId);
    const event = cast.state.eventLog.find((entry) => entry.type === 'searchFound');
    expect(event?.payload).toMatchObject({ name: 'Swamp', to: 'hand', revealed: true });
    const types = cast.state.eventLog.map((entry) => entry.type);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(types.indexOf('searchFound'));
    for (const viewer of ['P2', 'P3', 'P4']) {
      expect(formatPlayerLog(cast.state.eventLog, viewer).map((line) => line.text)).toContain(
        'reveals Swamp',
      );
    }
  });

  it('plasmancer-basic-swamp-only — snow basics count; nonbasic Swamps and other basics are never offered', () => {
    const ctx = castPlasmancer('plasmancer-filter');
    conjure(ctx, 'P1', snowSwamp(), 'library');
    conjure(ctx, 'P1', nonbasicSwamp(), 'library');
    const { decisions } = settle(ctx, answers([[SEARCH, /Put Snow-Covered Swamp into your hand/]]));
    const search = decisions.find((decision) => SEARCH.test(decision.prompt))!;
    const offered = search.options.map((option) => option.description);
    expect(offered).toContain('Put Snow-Covered Swamp into your hand');
    expect(offered).not.toContain('Put Plasma Bog into your hand');
    expect(offered).not.toContain('Put Forest into your hand');
    expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toContain('Snow-Covered Swamp');
  });

  it('plasmancer-find-nothing — with no Swamp it finds nothing, reveals nothing, and still shuffles', () => {
    const ctx = castPlasmancer('plasmancer-nothing');
    const handBefore = playerById(ctx, 'P1').hand.length;
    settle(ctx, answers([[SEARCH, /Find nothing/]]));
    expect(playerById(ctx, 'P1').hand).toHaveLength(handBefore);
    expect(ctx.state.eventLog.some((entry) => entry.type === 'searchFound')).toBe(false);
    expect(ctx.state.eventLog.some((entry) => entry.type === 'shuffle')).toBe(true);
  });

  it('plasmancer-search-hides-rest-of-library — opponents see the revealed Swamp but no other library card', () => {
    const ctx = castPlasmancer('plasmancer-private');
    conjure(ctx, 'P1', swamp(), 'library');
    conjure(ctx, 'P1', SECRET('Plasma Private Secret'), 'library');
    settle(ctx, answers([[SEARCH, /Put Swamp into your hand/]]));
    for (const viewer of ['P2', 'P3', 'P4']) {
      expect(JSON.stringify(buildPlayerView(ctx, viewer)), viewer).not.toContain(
        'Plasma Private Secret',
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 1.12 Sylvan Reclamation
// ---------------------------------------------------------------------------------------------

describe('Sylvan Reclamation', () => {
  const reclamation = pinned('Sylvan Reclamation');
  const relic = () => oracle({ name: 'Reclaim Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const charm = () => oracle({ name: 'Reclaim Charm', typeLine: 'Enchantment', manaCost: '{1}' });
  const golem = () =>
    oracle({ name: 'Reclaim Golem', typeLine: 'Artifact Creature — Golem', manaCost: '{3}' });

  const CHOOSE_TARGET = /^Choose target \d+ for /;
  const exiled = (ctx: GameContext, owner: string) =>
    ctx.state.exile.filter((card) => card.ownerId === owner).map((card) => card.name);

  /** Choose each named target in order for the up-to-two slot, then stop. */
  const pick =
    (...names: string[]): Answer =>
    (decision) => {
      if (CHOOSE_TARGET.test(decision.prompt)) {
        const next = names.shift();
        return next === undefined
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${next}$`));
      }
      return { index: 0, targets: new Map() };
    };

  /** Cast Sylvan Reclamation from P1's hand, answering the target choices with `answer`. */
  function cast(ctx: GameContext, answer: Answer) {
    const inHand = conjure(ctx, 'P1', reclamation.card, 'hand');
    addMana(playerById(ctx, 'P1'), [
      { symbol: 'G' },
      { symbol: 'W' },
      { symbol: 'G' },
      { symbol: 'G' },
      { symbol: 'G' },
    ]);
    const option = castOptionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    const { decisions } = takeAction(ctx, 'P1', option!.payload as PriorityActionPayload, answer);
    expect(ctx.state.stack).toHaveLength(1);
    return decisions;
  }

  const offeredTargets = (decisions: PendingDecision[]) =>
    decisions
      .filter((decision) => CHOOSE_TARGET.test(decision.prompt))
      .flatMap((decision) => decision.options.map((option) => option.description));

  it('sylvan-reclamation-pinned-oracle-supported — pins the Oracle and models the 0..2 exile plus revealing landcycling', () => {
    expect(reclamation.sha256).toBe(
      '5682177705c6c6ef5b2dccfc5926514a68168bac41623daea143bf738b440274',
    );
    const def = interpretCard(reclamation.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.targets).toEqual([
      expect.objectContaining({ kind: 'permanent', count: { min: 0, max: 2 } }),
    ]);
    expect(def.spellAbility?.effects).toEqual([{ op: 'exileEachChosen', targetSlot: 0 }]);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]).toMatchObject({
      zone: 'hand',
      costs: [{ kind: 'mana' }, { kind: 'discardSelf' }],
      ability: { effects: [{ op: 'searchLibrary', reveal: true }, { op: 'shuffle' }] },
    });
  });

  it('sylvan-reclamation-exiles-two — the normal cast exiles an artifact and an enchantment', () => {
    const ctx = pod('reclaim-two');
    const artifact = spawn(ctx, 'P2', relic());
    const enchantment = spawn(ctx, 'P3', charm());
    cast(ctx, pick('Reclaim Relic', 'Reclaim Charm'));
    expect(ctx.state.stack[0]?.countTargets?.[0]).toEqual([artifact.id, enchantment.id]);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === artifact.id)).toBe(false);
    expect(ctx.state.battlefield.some((entry) => entry.id === enchantment.id)).toBe(false);
    expect(exiled(ctx, 'P2')).toEqual(['Reclaim Relic']);
    expect(exiled(ctx, 'P3')).toEqual(['Reclaim Charm']);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Sylvan Reclamation',
    ]);
  });

  it('sylvan-reclamation-at-most-two — after two choices no third target is offered', () => {
    const ctx = pod('reclaim-max');
    spawn(ctx, 'P2', relic());
    spawn(ctx, 'P2', charm());
    const third = spawn(ctx, 'P2', golem());
    const decisions = cast(ctx, pick('Reclaim Relic', 'Reclaim Charm', 'Reclaim Golem'));
    expect(decisions.filter((decision) => CHOOSE_TARGET.test(decision.prompt))).toHaveLength(2);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === third.id)).toBe(true);
  });

  it('sylvan-reclamation-zero-targets — it can be cast choosing nothing, or with no artifact or enchantment at all', () => {
    const chosen = pod('reclaim-zero');
    const kept = spawn(chosen, 'P2', relic());
    cast(chosen, pick());
    resolveTop(chosen);
    expect(chosen.state.battlefield.some((entry) => entry.id === kept.id)).toBe(true);
    expect(playerById(chosen, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Sylvan Reclamation',
    ]);

    const empty = pod('reclaim-empty');
    cast(empty, pick());
    resolveTop(empty);
    expect(playerById(empty, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Sylvan Reclamation',
    ]);
  });

  it('sylvan-reclamation-target-filter — artifact creatures count; creatures and lands are never offered', () => {
    const ctx = pod('reclaim-filter');
    spawn(ctx, 'P2', golem());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', forest());
    const offered = offeredTargets(cast(ctx, pick('Reclaim Golem')));
    expect(offered).toContain('Target Reclaim Golem');
    expect(offered).not.toContain('Target Test Bear');
    expect(offered).not.toContain('Target Forest');
  });

  it('sylvan-reclamation-legality-decided-first — exiling one target does not make another illegal mid-resolution', () => {
    const ctx = pod('reclaim-simultaneous');
    // The Mutator makes its controller's creatures artifacts, so the Bear is a legal target
    // only while the Mutator is on the battlefield.
    const mutator = spawn(ctx, 'P2', charm());
    const mutatorDef = ctx.defs.get(mutator.oracleId)!;
    ctx.defs.set(mutator.oracleId, {
      ...mutatorDef,
      staticEffects: [
        { affects: allOf(ofType('Creature'), YOURS), op: { layer: 4, addTypes: ['Artifact'] } },
      ],
    });
    const bear_ = spawn(ctx, 'P2', bear());
    expect(computeCharacteristics(ctx, bear_).types).toContain('Artifact');
    cast(ctx, pick('Reclaim Charm', 'Test Bear'));
    resolveTop(ctx);
    expect(exiled(ctx, 'P2').sort()).toEqual(['Reclaim Charm', 'Test Bear']);
  });

  it('sylvan-reclamation-one-target-left — a target that left does not stop the other exile', () => {
    const ctx = pod('reclaim-partial');
    const artifact = spawn(ctx, 'P2', relic());
    const enchantment = spawn(ctx, 'P2', charm());
    cast(ctx, pick('Reclaim Relic', 'Reclaim Charm'));
    pump(moveObject(ctx, artifact, { zone: 'graveyard' }));
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Reclaim Relic']);
    expect(exiled(ctx, 'P2')).toEqual(['Reclaim Charm']);
    expect(ctx.state.battlefield.some((entry) => entry.id === enchantment.id)).toBe(false);
  });

  it('sylvan-reclamation-basic-landcycling-reveals — {2} and a discard search a revealed basic land into hand, then shuffle', () => {
    const ctx = pod('reclaim-cycling');
    const inHand = conjure(ctx, 'P1', reclamation.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    const activation = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === inHand.id;
    });
    expect(activation).toBeDefined();
    takeAction(ctx, 'P1', activation!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Sylvan Reclamation',
    ]);
    const handBefore = playerById(ctx, 'P1').hand.length;
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(handBefore + 1);
    const found = ctx.state.eventLog.find((event) => event.type === 'searchFound');
    expect(found?.payload).toMatchObject({ name: 'Forest', to: 'hand', revealed: true });
    expect(formatPlayerLog(ctx.state.eventLog, 'P2').map((line) => line.text)).toContain(
      'reveals Forest',
    );
    const types = ctx.state.eventLog.map((event) => event.type);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(types.indexOf('searchFound'));
  });

  it('sylvan-reclamation-landcycling-may-find-nothing — the hidden-zone search may fail to find even with a basic in the library', () => {
    const ctx = pod('reclaim-cycling-nothing');
    const inHand = conjure(ctx, 'P1', reclamation.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    const activation = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === inHand.id;
    });
    takeAction(ctx, 'P1', activation!.payload as PriorityActionPayload);
    const handBefore = playerById(ctx, 'P1').hand.length;
    const { decisions } = resolveTop(ctx, answers([[/search your library/i, /Find nothing/]]));
    // The library holds only Forests, yet the choice is still offered (CR 701.19b).
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description === 'Find nothing'),
      ),
    ).toBe(true);
    expect(playerById(ctx, 'P1').hand).toHaveLength(handBefore);
    expect(ctx.state.eventLog.some((event) => event.type === 'searchFound')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.13 Thunderfoot Baloth
// ---------------------------------------------------------------------------------------------

describe('Thunderfoot Baloth', () => {
  const baloth = pinned('Thunderfoot Baloth');
  const general = () =>
    oracle({ name: 'Baloth General', typeLine: 'Legendary Creature — Elf', manaCost: '{2}' });
  const relic = () => oracle({ name: 'Baloth Relic', typeLine: 'Artifact', manaCost: '{1}' });

  const stats = (ctx: GameContext, permanent: EnginePermanent) => {
    const c = computeCharacteristics(ctx, permanent);
    return { power: c.power, toughness: c.toughness, trample: c.keywords.includes('trample') };
  };

  /** P1 controls the Baloth and a bear; `commander` decides whether P1's commander is out. */
  function board(seed: string, commander: boolean) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', baloth.card);
    const bear_ = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const general_ = commander ? spawn(ctx, 'P1', general()) : undefined;
    if (general_ !== undefined) general_.isCommander = true;
    return { ctx, self, bear: bear_, theirs, general: general_ };
  }

  it('thunderfoot-baloth-pinned-oracle-supported — pins the Oracle and models trample plus the creature-only lieutenant statics', () => {
    expect(baloth.sha256).toBe('ad245d778eb6fdf24778c3037b47c0b0bb89e80346f64557ce250b39123fb23f');
    const def = interpretCard(baloth.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('trample');
    expect(def.staticEffects).toHaveLength(3);
    for (const effect of def.staticEffects) {
      expect(effect.condition).toEqual({ kind: 'controlsYourCommander' });
    }
  });

  it('thunderfoot-baloth-lieutenant-active — with your commander out it is 7/7 and other creatures you control get +2/+2 and trample', () => {
    const { ctx, self, bear: mine, theirs, general: commander } = board('baloth-on', true);
    expect(stats(ctx, self)).toEqual({ power: 7, toughness: 7, trample: true });
    expect(stats(ctx, mine)).toEqual({ power: 4, toughness: 4, trample: true });
    expect(stats(ctx, commander!)).toEqual({ power: 4, toughness: 4, trample: true });
    expect(stats(ctx, theirs)).toEqual({ power: 2, toughness: 2, trample: false });
  });

  it('thunderfoot-baloth-creatures-only — noncreature permanents you control gain nothing', () => {
    const { ctx } = board('baloth-noncreature', true);
    const artifact = spawn(ctx, 'P1', relic());
    const land = spawn(ctx, 'P1', forest());
    for (const permanent of [artifact, land]) {
      const c = computeCharacteristics(ctx, permanent);
      expect(c.keywords).not.toContain('trample');
      expect(c.power ?? 0).toBe(0);
      expect(c.toughness ?? 0).toBe(0);
    }
  });

  it('thunderfoot-baloth-no-commander — without your commander only its printed 5/5 trample remains', () => {
    const { ctx, self, bear: mine } = board('baloth-off', false);
    expect(stats(ctx, self)).toEqual({ power: 5, toughness: 5, trample: true });
    expect(stats(ctx, mine)).toEqual({ power: 2, toughness: 2, trample: false });
  });

  it("thunderfoot-baloth-commander-control — a stolen commander or another player's commander does not count", () => {
    const stolen = board('baloth-stolen', true);
    stolen.general!.controllerId = 'P2';
    expect(stats(stolen.ctx, stolen.self)).toEqual({ power: 5, toughness: 5, trample: true });
    expect(stats(stolen.ctx, stolen.bear)).toEqual({ power: 2, toughness: 2, trample: false });

    const borrowed = board('baloth-borrowed', false);
    const theirCommander = spawn(borrowed.ctx, 'P2', general());
    theirCommander.isCommander = true;
    theirCommander.controllerId = 'P1';
    expect(stats(borrowed.ctx, borrowed.self)).toEqual({ power: 5, toughness: 5, trample: true });
  });

  it('thunderfoot-baloth-cast-and-commander-leaves — casting it applies the buff, which ends when the commander leaves', () => {
    const ctx = pod('baloth-cast');
    const commander = spawn(ctx, 'P1', general());
    commander.isCommander = true;
    const mine = spawn(ctx, 'P1', bear());
    const inHand = conjure(ctx, 'P1', baloth.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 6 }, () => ({ symbol: 'G' as const })),
    );
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const self = ctx.state.battlefield.find((entry) => entry.name === 'Thunderfoot Baloth')!;
    expect(stats(ctx, self)).toEqual({ power: 7, toughness: 7, trample: true });
    expect(stats(ctx, mine)).toEqual({ power: 4, toughness: 4, trample: true });
    pump(moveObject(ctx, commander, { zone: 'graveyard' }));
    expect(stats(ctx, self)).toEqual({ power: 5, toughness: 5, trample: true });
    expect(stats(ctx, mine)).toEqual({ power: 2, toughness: 2, trample: false });
  });
});

// ---------------------------------------------------------------------------------------------
// 1.14 Tomb Fortress
// ---------------------------------------------------------------------------------------------

describe('Tomb Fortress', () => {
  const fortress = pinned('Tomb Fortress');
  const ghoul = () =>
    oracle({ name: 'Tomb Ghoul', typeLine: 'Creature — Zombie', manaCost: '{3}' });
  const wraith = () =>
    oracle({ name: 'Tomb Wraith', typeLine: 'Creature — Spirit', manaCost: '{2}' });
  const RETURN = /choose a card to return from your graveyard/;

  /** P1 controls an untapped Fortress with {2}{B}{B}{B} floating; `top` sits on its library. */
  function board(seed: string, top: OracleCard[]) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', fortress.card);
    for (const card of [...top].reverse()) conjure(ctx, 'P1', card, 'library');
    addMana(
      playerById(ctx, 'P1'),
      ['B', 'B', 'B', 'G', 'G'].map((symbol) => ({ symbol: symbol as 'B' | 'G' })),
    );
    return { ctx, self };
  }

  const activation = (ctx: GameContext, self: EnginePermanent) =>
    priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.objectId === self.id &&
        /Mill four/.test(option.description)
      );
    });

  function activate(ctx: GameContext, self: EnginePermanent, answer?: Answer) {
    const option = activation(ctx, self);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    return resolveTop(ctx, answer);
  }

  it('tomb-fortress-pinned-oracle-supported — pins the Oracle and models the land plus the sorcery-speed reanimation', () => {
    expect(fortress.sha256).toBe(
      '65ac436976204aa19616a5462be74a04d8081dd30adaddfeedfe8b3fcaef5329',
    );
    const def = interpretCard(fortress.card);
    expect(def.modeled).toBe(true);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([expect.objectContaining({ units: [['B']] })]);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]).toMatchObject({
      timing: 'sorcery',
      costs: [{ kind: 'mana' }, { kind: 'tap' }, { kind: 'exileSelf' }],
      ability: {
        targets: [],
        effects: [
          { op: 'mill', count: { kind: 'const', n: 4 } },
          { op: 'returnOneFromYourGraveyardToBattlefield' },
        ],
      },
    });
  });

  it('tomb-fortress-returns-milled-creature — a creature card milled by the ability can be the one returned', () => {
    const { ctx, self } = board('fortress-milled', [forest(), ghoul(), forest(), forest()]);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
    activate(ctx, self);
    const returned = ctx.state.battlefield.find((entry) => entry.name === 'Tomb Ghoul');
    expect(returned?.controllerId).toBe('P1');
    expect(ctx.state.battlefield.some((entry) => entry.id === self.id)).toBe(false);
    expect(ctx.state.exile.map((card) => card.name)).toContain('Tomb Fortress');
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Forest',
      'Forest',
      'Forest',
    ]);
    const types = ctx.state.eventLog.map((event) => event.type);
    expect(types.lastIndexOf('mill')).toBeLessThan(types.indexOf('graveyardToBattlefield'));
  });

  it('tomb-fortress-choose-after-mill — the choice offers creature cards already there and ones just milled', () => {
    const { ctx, self } = board('fortress-choice', [wraith(), forest(), forest(), forest()]);
    conjure(ctx, 'P1', ghoul(), 'graveyard');
    const { decisions } = activate(ctx, self, answers([[RETURN, /Return Tomb Wraith/]]));
    const choice = decisions.find((decision) => RETURN.test(decision.prompt))!;
    expect(choice.options.map((option) => option.description)).toEqual([
      'Return Tomb Ghoul to the battlefield',
      'Return Tomb Wraith to the battlefield',
    ]);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Tomb Wraith')).toBe(true);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Tomb Ghoul');
  });

  it('tomb-fortress-no-creature — with no creature card in your graveyard it only mills', () => {
    const { ctx, self } = board('fortress-none', []);
    conjure(ctx, 'P2', ghoul(), 'graveyard');
    activate(ctx, self);
    expect(playerById(ctx, 'P1').graveyard).toHaveLength(4);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Tomb Ghoul')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'graveyardToBattlefield')).toBe(false);
  });

  it('tomb-fortress-activation-limits — sorcery speed on your turn, with full mana and an untapped Fortress', () => {
    const { ctx, self } = board('fortress-limits', []);
    expect(activation(ctx, self)).toBeDefined();
    ctx.state.phase = 'beginning';
    ctx.state.step = 'upkeep';
    expect(activation(ctx, self)).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    self.tapped = true;
    expect(activation(ctx, self)).toBeUndefined();
    self.tapped = false;
    const poor = pod('fortress-poor');
    const poorSelf = spawn(poor, 'P1', fortress.card);
    addMana(playerById(poor, 'P1'), [{ symbol: 'B' }, { symbol: 'B' }, { symbol: 'G' }]);
    expect(activation(poor, poorSelf)).toBeUndefined();
  });

  it('tomb-fortress-enters-tapped — played as a land it enters tapped', () => {
    const ctx = pod('fortress-land');
    const inHand = conjure(ctx, 'P1', fortress.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(play).toBeDefined();
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.find((entry) => entry.name === 'Tomb Fortress')?.tapped).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 1.15 Voice of Many
// ---------------------------------------------------------------------------------------------

describe('Voice of Many', () => {
  const voice = pinned('Voice of Many');

  /** Give each seat `counts[seat]` bears, then cast Voice of Many from P1's hand and settle. */
  function castWith(
    seed: string,
    counts: Record<string, number>,
    before?: (ctx: GameContext) => void,
  ) {
    const ctx = pod(seed);
    for (const [seat, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i++) spawn(ctx, seat, bear());
    }
    before?.(ctx);
    const inHand = conjure(ctx, 'P1', voice.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 4 }, () => ({ symbol: 'G' as const })),
    );
    const handBefore = playerById(ctx, 'P1').hand.length - 1;
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    settle(ctx);
    return { ctx, drawn: playerById(ctx, 'P1').hand.length - handBefore };
  }

  it('voice-of-many-pinned-oracle-supported — pins the Oracle and models the enters draw', () => {
    expect(voice.sha256).toBe('63a689cdc880b92b9c729e38b25e18cdb455d1c284bbd306e20cdb6e8fa787c7');
    const def = interpretCard(voice.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: { when: 'enters', subject: { kind: 'self' } },
        effects: [{ op: 'draw', count: { kind: 'countOpponentsWithFewerCreatures' } }],
      }),
    ]);
  });

  it('voice-of-many-draws-per-opponent-with-fewer — counts itself, and an opponent with equal creatures does not count', () => {
    // P1 ends with two creatures (a bear and the Voice): P2 (0) and P3 (1) have fewer, P4 (2) does not.
    const { drawn } = castWith('voice-count', { P1: 1, P3: 1, P4: 2 });
    expect(drawn).toBe(2);
  });

  it('voice-of-many-no-opponent-fewer — draws nothing when every opponent has at least as many', () => {
    const { drawn } = castWith('voice-none', { P2: 1, P3: 1, P4: 3 });
    expect(drawn).toBe(0);
  });

  it('voice-of-many-ignores-eliminated-players — a player who has left the game is not an opponent', () => {
    const { ctx, drawn } = castWith('voice-eliminated', { P3: 2, P4: 1 }, (game) => {
      playerById(game, 'P2').life = 0;
      pump(priorityCheckpoint(game));
      expect(playerById(game, 'P2').hasLost).toBe(true);
    });
    // P1 has only the Voice; P3 (2) and P4 (1) do not have fewer. P2, with no creatures, would
    // have counted had it still been in the game.
    expect(ctx.state.eliminatedPlayers).toContain('P2');
    expect(drawn).toBe(0);
  });

  it('voice-of-many-counts-on-resolution — creature counts are read as the trigger resolves', () => {
    const ctx = pod('voice-resolution');
    spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', voice.card);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const theirs = ctx.state.battlefield.find((entry) => entry.controllerId === 'P2')!;
    pump(moveObject(ctx, theirs, { zone: 'graveyard' }));
    const handBefore = playerById(ctx, 'P1').hand.length;
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand.length - handBefore).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.16 Foe-Razer Regent
// ---------------------------------------------------------------------------------------------

describe('Foe-Razer Regent', () => {
  const regent = pinned('Foe-Razer Regent');
  const FIGHT = /fight target creature you don't control/i;
  /** A plain "target creature fights another target creature" spell, for fights the Regent didn't start. */
  const LAB_FIGHT: Ability = {
    kind: 'spell',
    targets: [{ kind: 'creature' }, { kind: 'creature' }],
    effects: [{ op: 'fight', first: 0, second: 1 }],
  };

  function toEndStep(ctx: GameContext) {
    ctx.state.phase = 'ending';
    ctx.state.step = 'end';
    queueStepTriggers(ctx, 'endStep');
    settle(ctx);
  }

  const plusOnes = (ctx: GameContext, cardId: string) =>
    ctx.state.battlefield.find((entry) => entry.cardId === cardId)?.counters['+1/+1'] ?? 0;

  /** Cast the Regent from P1's hand, answering its optional fight with `accept`. */
  function castRegent(ctx: GameContext, accept: boolean, targetId?: string) {
    const inHand = conjure(ctx, 'P1', regent.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 7 }, () => ({ symbol: 'G' as const })),
    );
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const result = settle(ctx, (decision) => {
      if (decision.decisionType === 'optionalTrigger') {
        return optionMatching(decision, accept ? /^Yes$/ : /^No$/);
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined && targetId !== undefined) {
        return { index: 0, targets: new Map([[slot.slot, targetId]]) };
      }
      return { index: 0, targets: new Map() };
    });
    const self = ctx.state.battlefield.find((entry) => entry.name === 'Foe-Razer Regent')!;
    return { self, decisions: result.decisions };
  }

  it('foe-razer-regent-pinned-oracle-supported — pins the Oracle and models flying, the optional fight, and the fights trigger', () => {
    expect(regent.sha256).toBe('538901867581226afa96f2206428146725bae81b91a1120ce5a42696a415e4ea');
    const def = interpretCard(regent.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.triggers[0]).toMatchObject({
      optional: true,
      targets: [{ kind: 'creature', controller: 'opponent' }],
      effects: [{ op: 'fight', first: 'source', second: 0 }],
    });
    expect(def.triggers[1]).toMatchObject({
      trigger: { when: 'fights' },
      effects: [{ op: 'registerDelayedTrigger', when: 'endStep', sameObject: true }],
    });
  });

  it('foe-razer-regent-fight-then-counters — casting it and accepting fights, then it gets two +1/+1 counters at the end step', () => {
    const ctx = pod('regent-fight');
    const victim = spawn(ctx, 'P2', bear());
    const { self } = castRegent(ctx, true, victim.id);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
    expect(self.damageMarked).toBe(2);
    expect(plusOnes(ctx, self.cardId)).toBe(0);
    toEndStep(ctx);
    expect(plusOnes(ctx, self.cardId)).toBe(2);
  });

  it('foe-razer-regent-decline — answering no means no fight and no counters', () => {
    const ctx = pod('regent-decline');
    const victim = spawn(ctx, 'P2', bear());
    const { self, decisions } = castRegent(ctx, false, victim.id);
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(true);
    toEndStep(ctx);
    expect(plusOnes(ctx, self.cardId)).toBe(0);
  });

  it("foe-razer-regent-no-target — without a creature you don't control the fight trigger never asks", () => {
    const ctx = pod('regent-no-target');
    spawn(ctx, 'P1', bear());
    const { decisions } = castRegent(ctx, true);
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
    expect(decisions.some((decision) => FIGHT.test(decision.prompt))).toBe(false);
    expect(ctx.state.battlefield.filter((entry) => entry.name === 'Test Bear')).toHaveLength(1);
  });

  it("foe-razer-regent-any-creature-you-control — another creature of yours that fights gets the counters; the opponent's does not", () => {
    const ctx = pod('regent-other');
    spawn(ctx, 'P1', regent.card);
    const mine = spawn(
      ctx,
      'P1',
      oracle({ name: 'Regent Brute', typeLine: 'Creature — Ogre', power: '5', toughness: '5' }),
    );
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Regent Rival', typeLine: 'Creature — Ogre', power: '1', toughness: '6' }),
    );
    pump(
      executeAbility(
        ctx,
        { cardId: 'fight-spell', oracleId: 'fight-spell', name: 'Lab Fight', controllerId: 'P1' },
        LAB_FIGHT,
        [mine.id, theirs.id],
      ),
    );
    settle(ctx);
    toEndStep(ctx);
    expect(plusOnes(ctx, mine.cardId)).toBe(2);
    expect(plusOnes(ctx, theirs.cardId)).toBe(0);
  });

  it('foe-razer-regent-new-object-gets-nothing — a creature that left and returned before the end step is a new object', () => {
    const ctx = pod('regent-blink');
    spawn(ctx, 'P1', regent.card);
    const mine = spawn(
      ctx,
      'P1',
      oracle({ name: 'Regent Brute', typeLine: 'Creature — Ogre', power: '5', toughness: '5' }),
    );
    const theirs = spawn(ctx, 'P2', bear());
    pump(
      executeAbility(
        ctx,
        { cardId: 'fight-spell', oracleId: 'fight-spell', name: 'Lab Fight', controllerId: 'P1' },
        LAB_FIGHT,
        [mine.id, theirs.id],
      ),
    );
    settle(ctx);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    pump(moveObject(ctx, mine, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === mine.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    toEndStep(ctx);
    expect(plusOnes(ctx, mine.cardId)).toBe(0);
  });

  it('foe-razer-regent-blink-in-response — a creature blinked while the Regent trigger waits is a new object that never fought', () => {
    const ctx = pod('regent-blink-in-response');
    spawn(ctx, 'P1', regent.card);
    const mine = spawn(
      ctx,
      'P1',
      oracle({ name: 'Regent Brute', typeLine: 'Creature — Ogre', power: '5', toughness: '5' }),
    );
    const theirs = spawn(ctx, 'P2', bear());
    pump(
      executeAbility(
        ctx,
        { cardId: 'fight-spell', oracleId: 'fight-spell', name: 'Lab Fight', controllerId: 'P1' },
        LAB_FIGHT,
        [mine.id, theirs.id],
      ),
    );
    // The Regent's trigger goes on the stack; before it resolves the creature is blinked.
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, mine, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === mine.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    resolveTop(ctx);
    toEndStep(ctx);
    expect(plusOnes(ctx, mine.cardId)).toBe(0);
  });

  it('foe-razer-regent-token-fighter-died — a token that died fighting ceased to exist; the end step does nothing and does not halt', () => {
    const ctx = pod('regent-token-died');
    spawn(ctx, 'P1', regent.card);
    const token = spawn(ctx, 'P1', bear());
    token.isToken = true;
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Regent Rival', typeLine: 'Creature — Ogre', power: '5', toughness: '5' }),
    );
    pump(
      executeAbility(
        ctx,
        { cardId: 'fight-spell', oracleId: 'fight-spell', name: 'Lab Fight', controllerId: 'P1' },
        LAB_FIGHT,
        [token.id, theirs.id],
      ),
    );
    settle(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === token.id)).toBe(false);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(() => toEndStep(ctx)).not.toThrow();
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('foe-razer-regent-fighter-died — a creature that died from the fight gets nothing and the game continues', () => {
    const ctx = pod('regent-fighter-died');
    spawn(ctx, 'P1', regent.card);
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(
      ctx,
      'P2',
      oracle({ name: 'Regent Rival', typeLine: 'Creature — Ogre', power: '5', toughness: '5' }),
    );
    pump(
      executeAbility(
        ctx,
        { cardId: 'fight-spell', oracleId: 'fight-spell', name: 'Lab Fight', controllerId: 'P1' },
        LAB_FIGHT,
        [mine.id, theirs.id],
      ),
    );
    settle(ctx);
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === mine.cardId)).toBe(
      true,
    );
    expect(() => toEndStep(ctx)).not.toThrow();
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.17 Hunting Wilds
// ---------------------------------------------------------------------------------------------

describe('Hunting Wilds', () => {
  const wilds = pinned('Hunting Wilds');
  const grove = () =>
    oracle({
      name: 'Wilds Grove',
      typeLine: 'Land — Forest Plains',
      manaCost: null,
      oracleText: '({T}: Add {G} or {W}.)',
    });
  const SEARCH = /search for a Forest card/;

  const castOptions = (ctx: GameContext, objectId: string) =>
    priorityOptions(ctx, 'P1').filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === objectId;
    });
  const kickCount = (option: { payload?: unknown }) =>
    (option.payload as { optionalCostCount?: number }).optionalCostCount ?? 0;

  /** Cast Hunting Wilds with `mana` green floating, kicked or not, and resolve it with `answer`. */
  function cast(seed: string, kicked: boolean, answer: Answer, mana = 8) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', wilds.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: mana }, () => ({ symbol: 'G' as const })),
    );
    const option = castOptions(ctx, inHand.id).find(
      (candidate) => kickCount(candidate) === (kicked ? 1 : 0),
    );
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    const result = resolveTop(ctx, answer);
    const forests = ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1');
    return { ctx, forests, decisions: result.decisions };
  }

  const twoForests = answers([[SEARCH, /Put Forest onto the battlefield tapped/]]);

  it('hunting-wilds-pinned-oracle-supported — pins the Oracle and models kicker plus the search', () => {
    expect(wilds.sha256).toBe('b673b9cfa9797a896494a8d2751fe9cce08e1787a1e866d6b8b23ce3b3ba5804');
    const def = interpretCard(wilds.card);
    expect(def.modeled).toBe(true);
    expect(def.optionalAdditionalCost).toEqual({
      mechanic: 'kicker',
      cost: expect.objectContaining({ generic: 3, colored: expect.objectContaining({ G: 1 }) }),
    });
    expect(def.spellAbility?.effects).toEqual([{ op: 'huntingWilds' }]);
  });

  it('hunting-wilds-unkicked — finds up to two Forests tapped, then shuffles; they stay plain lands', () => {
    const { ctx, forests } = cast('wilds-plain', false, twoForests, 4);
    expect(forests).toHaveLength(2);
    for (const forest_ of forests) {
      expect(forest_.tapped).toBe(true);
      expect(computeCharacteristics(ctx, forest_).types).not.toContain('Creature');
    }
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('hunting-wilds-kicked — the found Forests untap and become 3/3 green haste creatures that are still lands, for good', () => {
    const { ctx, forests } = cast('wilds-kicked', true, twoForests);
    expect(forests).toHaveLength(2);
    for (const forest_ of forests) {
      expect(forest_.tapped).toBe(false);
      const c = computeCharacteristics(ctx, forest_);
      expect(c.types).toEqual(expect.arrayContaining(['Land', 'Creature']));
      expect(c.subtypes).toContain('Forest');
      expect([c.power, c.toughness]).toEqual([3, 3]);
      expect(c.colors).toEqual(['G']);
      expect(c.keywords).toContain('haste');
    }
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, forests[0]!).power).toBe(3);
  });

  it('hunting-wilds-animation-ends-on-zone-change — a Forest that leaves and is played again is a new object and only a land', () => {
    const { ctx, forests } = cast('wilds-zone-change', true, twoForests);
    const [bounced, kept] = forests as [EnginePermanent, EnginePermanent];
    pump(moveObject(ctx, bounced, { zone: 'hand' }));
    const card = playerById(ctx, 'P1').hand.find((entry) => entry.cardId === bounced.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    const replayed = ctx.state.battlefield.find((entry) => entry.cardId === bounced.cardId)!;
    expect(computeCharacteristics(ctx, replayed).types).not.toContain('Creature');
    // The other Forest it animated is still a 3/3 creature land.
    expect(computeCharacteristics(ctx, kept).types).toContain('Creature');
    expect(computeCharacteristics(ctx, kept).power).toBe(3);
  });

  it('hunting-wilds-animated-forest-dies-as-creature — an animated Forest that is destroyed dies as a creature', () => {
    const { ctx, forests } = cast('wilds-forest-dies', true, twoForests);
    const before = ctx.state.creaturesDiedThisTurn;
    pump(moveObject(ctx, forests[0]!, { zone: 'graveyard' }));
    expect(ctx.state.creaturesDiedThisTurn).toBe(before + 1);
  });

  it('hunting-wilds-effects-dropped-after-last-forest-leaves — the permanent animation is removed once every Forest it animated has left', () => {
    const { ctx, forests } = cast('wilds-effects-dropped', true, twoForests);
    const animating = () =>
      ctx.state.effects.filter((effect) =>
        forests.some((forest_) => effect.targetCardIds.includes(forest_.cardId)),
      );
    const created = animating().length;
    expect(created).toBeGreaterThan(0);
    pump(moveObject(ctx, forests[0]!, { zone: 'hand' }));
    // The other Forest still holds every effect.
    expect(animating()).toHaveLength(created);
    const total = ctx.state.effects.length;
    pump(moveObject(ctx, forests[1]!, { zone: 'hand' }));
    expect(animating()).toHaveLength(0);
    expect(ctx.state.effects).toHaveLength(total - created);
  });

  it('hunting-wilds-kicker-cost — kicking needs the extra {3}{G}; with four mana only the plain cast is offered', () => {
    const ctx = pod('wilds-cost');
    const inHand = conjure(ctx, 'P1', wilds.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 4 }, () => ({ symbol: 'G' as const })),
    );
    expect(castOptions(ctx, inHand.id).map(kickCount)).toEqual([0]);
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 4 }, () => ({ symbol: 'G' as const })),
    );
    expect(castOptions(ctx, inHand.id).map(kickCount)).toEqual([0, 1]);
  });

  it('hunting-wilds-forest-cards-only-this-way — any Forest card qualifies, finding nothing is allowed, and only the found Forests animate', () => {
    const ctx = pod('wilds-filter');
    const old = spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', grove(), 'library');
    const inHand = conjure(ctx, 'P1', wilds.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 8 }, () => ({ symbol: 'G' as const })),
    );
    const option = castOptions(ctx, inHand.id).find((candidate) => kickCount(candidate) === 1)!;
    takeAction(ctx, 'P1', option.payload as PriorityActionPayload);
    let picks = 0;
    const { decisions } = resolveTop(ctx, (decision) =>
      SEARCH.test(decision.prompt)
        ? optionMatching(decision, picks++ === 0 ? /Put Wilds Grove/ : /Find nothing/)
        : { index: 0, targets: new Map() },
    );
    expect(decisions.filter((decision) => SEARCH.test(decision.prompt))).toHaveLength(2);
    const groveOnField = ctx.state.battlefield.find((entry) => entry.name === 'Wilds Grove')!;
    expect(computeCharacteristics(ctx, groveOnField).power).toBe(3);
    expect(computeCharacteristics(ctx, old).types).not.toContain('Creature');
    expect(ctx.state.battlefield.filter((entry) => entry.name === 'Forest')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.18 Loran of the Third Path
// ---------------------------------------------------------------------------------------------

describe('Loran of the Third Path', () => {
  const loran = pinned('Loran of the Third Path');
  const relic = () => oracle({ name: 'Loran Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const charm = () => oracle({ name: 'Loran Charm', typeLine: 'Enchantment', manaCost: '{1}' });
  const vault = () =>
    oracle({
      name: 'Loran Vault',
      typeLine: 'Artifact',
      manaCost: '{3}',
      oracleText: 'Indestructible',
      keywords: ['Indestructible'],
    });
  const CHOOSE = /choose (a|another) target/i;

  /** Choose `name` (or no target) for the up-to-one slot. */
  const pick =
    (name: string | null): Answer =>
    (decision) => {
      if (CHOOSE.test(decision.prompt)) {
        return name === null
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${name}$`));
      }
      return { index: 0, targets: new Map() };
    };

  /** Cast Loran from P1's hand and settle its enters trigger with `answer`. */
  function castLoran(ctx: GameContext, answer: Answer) {
    const inHand = conjure(ctx, 'P1', loran.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'W' }, { symbol: 'W' }]);
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const { decisions } = settle(ctx, answer);
    return decisions;
  }

  const offered = (decisions: PendingDecision[]) =>
    decisions
      .filter((decision) => CHOOSE.test(decision.prompt))
      .flatMap((decision) => decision.options.map((option) => option.description));

  it('loran-of-the-third-path-pinned-oracle-supported — pins the Oracle and models vigilance, the up-to-one destroy, and the draw ability', () => {
    expect(loran.sha256).toBe('1113e09d5ae37057a26a4ed71a643206eb4ca8bb572b7116b0107ff2ebdd3454');
    const def = interpretCard(loran.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('vigilance');
    expect(def.triggers[0]?.targets).toEqual([
      expect.objectContaining({ kind: 'permanent', count: { min: 0, max: 1 } }),
    ]);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'destroyEachChosen', targetSlot: 0 }]);
    expect(def.activatedAbilities[0]).toMatchObject({
      costs: [{ kind: 'tap' }],
      ability: {
        targets: [{ kind: 'player', controller: 'opponent' }],
        effects: [{ op: 'drawTargetAndController', target: 0 }],
      },
    });
  });

  it('loran-of-the-third-path-destroys-chosen — casting it destroys the chosen artifact or enchantment, whoever controls it', () => {
    const ctx = pod('loran-destroy');
    const theirs = spawn(ctx, 'P2', charm());
    const mine = spawn(ctx, 'P1', relic());
    const decisions = castLoran(ctx, pick('Loran Relic'));
    expect(offered(decisions)).toEqual(
      expect.arrayContaining(['Target Loran Relic', 'Target Loran Charm']),
    );
    expect(ctx.state.battlefield.some((entry) => entry.id === mine.id)).toBe(false);
    expect(ctx.state.battlefield.some((entry) => entry.id === theirs.id)).toBe(true);
  });

  it('loran-of-the-third-path-zero-targets — choosing nothing, or having nothing to choose, destroys nothing', () => {
    const chosen = pod('loran-none');
    const kept = spawn(chosen, 'P2', relic());
    castLoran(chosen, pick(null));
    expect(chosen.state.battlefield.some((entry) => entry.id === kept.id)).toBe(true);

    const empty = pod('loran-empty');
    const decisions = castLoran(empty, pick(null));
    expect(offered(decisions)).toEqual([]);
    expect(empty.state.battlefield.some((entry) => entry.name === 'Loran of the Third Path')).toBe(
      true,
    );
  });

  it('loran-of-the-third-path-filter-and-indestructible — creatures and lands are not offered; an indestructible artifact survives', () => {
    const ctx = pod('loran-filter');
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', forest());
    const survivor = spawn(ctx, 'P2', vault());
    const decisions = castLoran(ctx, pick('Loran Vault'));
    expect(offered(decisions)).not.toContain('Target Test Bear');
    expect(offered(decisions)).not.toContain('Target Forest');
    expect(ctx.state.battlefield.some((entry) => entry.id === survivor.id)).toBe(true);
  });

  it('loran-of-the-third-path-tap-draw — {T}: you and the target opponent each draw; it needs an untapped, non-sick Loran', () => {
    const ctx = pod('loran-draw');
    const self = spawn(ctx, 'P1', loran.card);
    self.summoningSick = true;
    expect(activationOf(ctx, 'P1', self)).toBeUndefined();
    self.summoningSick = false;
    const option = activationOf(ctx, 'P1', self);
    expect(option).toBeDefined();
    const before = { P1: playerById(ctx, 'P1').hand.length, P3: playerById(ctx, 'P3').hand.length };
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P3']]),
    );
    expect(option!.targets?.[0]?.options).toEqual(expect.arrayContaining(['P2', 'P3', 'P4']));
    expect(option!.targets?.[0]?.options).not.toContain('P1');
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand.length).toBe(before.P1 + 1);
    expect(playerById(ctx, 'P3').hand.length).toBe(before.P3 + 1);
    expect(playerById(ctx, 'P2').hand).toHaveLength(0);
    expect(self.tapped).toBe(true);
  });

  it('loran-of-the-third-path-draw-apnap — the players draw in APNAP order, whoever is active', () => {
    const drawOrder = (active: string) => {
      const ctx = pod(`loran-apnap-${active}`);
      ctx.state.currentTurnPlayer = active;
      ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(active);
      const self = spawn(ctx, 'P1', loran.card);
      self.summoningSick = false;
      const ability = interpretCard(loran.card).activatedAbilities[0]!.ability;
      pump(
        executeAbility(
          ctx,
          { cardId: self.cardId, oracleId: self.oracleId, name: self.name, controllerId: 'P1' },
          ability,
          ['P3' as ObjectId],
        ),
      );
      return ctx.state.eventLog
        .filter((event) => event.type === 'draw')
        .map((event) => event.actorSeat);
    };
    // CR 101.4: on P1's turn P1 draws first; on P3's turn P3 does.
    expect(drawOrder('P1')).toEqual(['P1', 'P3']);
    expect(drawOrder('P3')).toEqual(['P3', 'P1']);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.19 Rishkar, Peema Renegade
// ---------------------------------------------------------------------------------------------

describe('Rishkar, Peema Renegade', () => {
  const rishkar = pinned('Rishkar, Peema Renegade');
  const CHOOSE = /choose (a|another) target/i;

  /** Choose each named creature, in order, for the up-to-two slot, then stop. */
  const pick =
    (...names: string[]): Answer =>
    (decision) => {
      if (CHOOSE.test(decision.prompt)) {
        const next = names.shift();
        return next === undefined
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${next}$`));
      }
      return { index: 0, targets: new Map() };
    };

  function castRishkar(ctx: GameContext, answer: Answer) {
    const inHand = conjure(ctx, 'P1', rishkar.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }, { symbol: 'G' }]);
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    return settle(ctx, answer).decisions;
  }

  const sourcesOf = (ctx: GameContext, playerId: string) =>
    manaSourcesFor(ctx, playerId).map((source) => source.cardId);

  it('rishkar-peema-renegade-pinned-oracle-supported — pins the Oracle and models the up-to-two counters and the granted mana ability', () => {
    expect(rishkar.sha256).toBe('d0ebd951555eaeb46229fdf0a02a614e3752b215aeafd80d90078ec75008f758');
    const def = interpretCard(rishkar.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.targets).toEqual([{ kind: 'creature', count: { min: 0, max: 2 } }]);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 },
    ]);
    expect(def.staticEffects).toEqual([
      expect.objectContaining({
        op: { layer: 6, addManaAbility: { units: [['G']], costs: [{ kind: 'tap' }] } },
      }),
    ]);
  });

  it('rishkar-peema-renegade-two-counters — casting it puts one counter on each of two chosen creatures, any controller', () => {
    const ctx = pod('rishkar-two');
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Rishkar Rival', typeLine: 'Creature — Elf' }));
    castRishkar(ctx, pick('Test Bear', 'Rishkar Rival'));
    expect(mine.counters['+1/+1']).toBe(1);
    expect(theirs.counters['+1/+1']).toBe(1);
  });

  it('rishkar-peema-renegade-zero-targets — it may choose no creature and still resolves', () => {
    const ctx = pod('rishkar-zero');
    const mine = spawn(ctx, 'P1', bear());
    const decisions = castRishkar(ctx, pick());
    expect(decisions.some((decision) => CHOOSE.test(decision.prompt))).toBe(true);
    expect(mine.counters['+1/+1'] ?? 0).toBe(0);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Rishkar, Peema Renegade')).toBe(
      true,
    );
  });

  it('rishkar-peema-renegade-mana-grant — your creatures with any counter tap for {G}; others and opponents do not', () => {
    const ctx = pod('rishkar-mana');
    spawn(ctx, 'P1', rishkar.card);
    const countered = spawn(ctx, 'P1', bear());
    countered.counters['+1/+1'] = 1;
    const otherCounter = spawn(
      ctx,
      'P1',
      oracle({ name: 'Rishkar Shard', typeLine: 'Creature — Elf' }),
    );
    otherCounter.counters['-1/-1'] = 1;
    const plain = spawn(ctx, 'P1', oracle({ name: 'Rishkar Plain', typeLine: 'Creature — Elf' }));
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Rishkar Rival', typeLine: 'Creature — Elf' }));
    theirs.counters['+1/+1'] = 1;
    const relic = spawn(ctx, 'P1', oracle({ name: 'Rishkar Relic', typeLine: 'Artifact' }));
    relic.counters['charge'] = 1;
    const mine = sourcesOf(ctx, 'P1');
    expect(mine).toEqual(expect.arrayContaining([countered.cardId, otherCounter.cardId]));
    expect(mine).not.toContain(plain.cardId);
    expect(mine).not.toContain(relic.cardId);
    expect(sourcesOf(ctx, 'P2')).not.toContain(theirs.cardId);
    expect(
      manaSourcesFor(ctx, 'P1').find((source) => source.cardId === countered.cardId)?.units,
    ).toEqual([['G']]);
  });

  it('rishkar-peema-renegade-summoning-sick — a countered creature that just arrived cannot tap for mana', () => {
    const ctx = pod('rishkar-sick');
    spawn(ctx, 'P1', rishkar.card);
    const fresh = spawn(ctx, 'P1', bear());
    fresh.counters['+1/+1'] = 1;
    fresh.summoningSick = true;
    expect(sourcesOf(ctx, 'P1')).not.toContain(fresh.cardId);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.20 Vastwood Surge
// ---------------------------------------------------------------------------------------------

describe('Vastwood Surge', () => {
  const surge = pinned('Vastwood Surge');
  const SEARCH = /search your library/i;
  const grove = () =>
    oracle({
      name: 'Surge Grove',
      typeLine: 'Land — Forest Plains',
      manaCost: null,
      oracleText: '({T}: Add {G} or {W}.)',
    });

  const castOptions = (ctx: GameContext, objectId: string) =>
    priorityOptions(ctx, 'P1').filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === objectId;
    });
  const kickCount = (option: { payload?: unknown }) =>
    (option.payload as { optionalCostCount?: number }).optionalCostCount ?? 0;

  function cast(ctx: GameContext, kicked: boolean, answer: Answer, mana = 8) {
    const inHand = conjure(ctx, 'P1', surge.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: mana }, () => ({ symbol: 'G' as const })),
    );
    const option = castOptions(ctx, inHand.id).find(
      (candidate) => kickCount(candidate) === (kicked ? 1 : 0),
    );
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    return resolveTop(ctx, answer).decisions;
  }

  const twoForests = answers([[SEARCH, /Put Forest onto the battlefield tapped/]]);
  const lands = (ctx: GameContext) =>
    ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1' && entry.name === 'Forest');

  it('vastwood-surge-pinned-oracle-supported — pins the Oracle and models kicker, the basic search, and the kicked counters', () => {
    expect(surge.sha256).toBe('5922182fae289ab48ae49f025ac55977e4bf45975284d4d5b0663666de3fd5f5');
    const def = interpretCard(surge.card);
    expect(def.modeled).toBe(true);
    expect(def.optionalAdditionalCost).toEqual({
      mechanic: 'kicker',
      cost: expect.objectContaining({ generic: 4 }),
    });
    expect(def.spellAbility?.effects).toEqual([
      expect.objectContaining({ op: 'searchLibrary', allowFailToFind: true }),
      { op: 'shuffle' },
      expect.objectContaining({ op: 'putCountersEach', counter: '+1/+1' }),
    ]);
  });

  it('vastwood-surge-unkicked — finds up to two basics tapped and puts no counters', () => {
    const ctx = pod('surge-plain');
    const mine = spawn(ctx, 'P1', bear());
    cast(ctx, false, twoForests, 4);
    expect(lands(ctx)).toHaveLength(2);
    expect(lands(ctx).every((land) => land.tapped)).toBe(true);
    expect(mine.counters['+1/+1'] ?? 0).toBe(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('vastwood-surge-kicked — a kicked cast puts two +1/+1 counters on each creature you control only', () => {
    const ctx = pod('surge-kicked');
    const mine = spawn(ctx, 'P1', bear());
    const token = spawn(ctx, 'P1', bear(), { isToken: true });
    const theirs = spawn(ctx, 'P2', bear());
    cast(ctx, true, twoForests);
    expect(mine.counters['+1/+1']).toBe(2);
    expect(token.counters['+1/+1']).toBe(2);
    expect(theirs.counters['+1/+1'] ?? 0).toBe(0);
    expect(lands(ctx).every((land) => (land.counters['+1/+1'] ?? 0) === 0)).toBe(true);
  });

  it('vastwood-surge-kicker-cost — the kicked cast needs the extra {4}', () => {
    const ctx = pod('surge-cost');
    const inHand = conjure(ctx, 'P1', surge.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 7 }, () => ({ symbol: 'G' as const })),
    );
    expect(castOptions(ctx, inHand.id).map(kickCount)).toEqual([0]);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    expect(castOptions(ctx, inHand.id).map(kickCount)).toEqual([0, 1]);
  });

  it('vastwood-surge-basic-only-up-to-two — a nonbasic land is never offered, and it may stop early', () => {
    const ctx = pod('surge-filter');
    conjure(ctx, 'P1', grove(), 'library');
    let picks = 0;
    const decisions = cast(
      ctx,
      false,
      (decision) =>
        SEARCH.test(decision.prompt)
          ? optionMatching(decision, picks++ === 0 ? /Put Forest/ : /Find nothing/)
          : { index: 0, targets: new Map() },
      4,
    );
    const searches = decisions.filter((decision) => SEARCH.test(decision.prompt));
    for (const search of searches) {
      expect(search.options.map((option) => option.description).join('|')).not.toContain(
        'Surge Grove',
      );
    }
    expect(lands(ctx)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.21 Frontier Siege
// ---------------------------------------------------------------------------------------------

describe('Frontier Siege', () => {
  const siege = pinned('Frontier Siege');
  const drake = () =>
    oracle({
      name: 'Siege Drake',
      typeLine: 'Creature — Drake',
      oracleText: 'Flying',
      keywords: ['Flying'],
      power: '3',
      toughness: '3',
    });
  const MODE = /Choose Khans or Dragons/;

  /** Cast Frontier Siege from P1's hand choosing `mode`. */
  function castSiege(ctx: GameContext, mode: 'Khans' | 'Dragons') {
    const inHand = conjure(ctx, 'P1', siege.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 4 }, () => ({ symbol: 'G' as const })),
    );
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    const { decisions } = resolveTop(ctx, answers([[MODE, new RegExp(`^${mode} —`)]]));
    expect(decisions.some((decision) => MODE.test(decision.prompt))).toBe(true);
    return ctx.state.battlefield.find((entry) => entry.name === 'Frontier Siege')!;
  }

  const green = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).manaEntries.filter((entry) => entry.symbol === 'G').length;

  function mainPhase(ctx: GameContext, active: string) {
    ctx.state.currentTurnPlayer = active;
    ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(active);
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    queueStepTriggers(ctx, 'mainPhase');
    settle(ctx);
  }

  const fightAnswer =
    (accept: boolean): Answer =>
    (decision) =>
      decision.decisionType === 'optionalTrigger'
        ? optionMatching(decision, accept ? /^Yes$/ : /^No$/)
        : { index: 0, targets: new Map() };

  it('frontier-siege-pinned-oracle-supported — pins the Oracle and models the as-enters mode and both mode abilities', () => {
    expect(siege.sha256).toBe('1b195bc9d7e3f03e803eb4ad56d689fbd073b725d5ce8076b9998e0740982641');
    const def = interpretCard(siege.card);
    expect(def.modeled).toBe(true);
    expect(def.entersChoosingOption?.options?.map((option) => option.key)).toEqual([
      'Khans',
      'Dragons',
    ]);
    expect(def.triggers.map((trigger) => trigger.trigger?.condition)).toEqual([
      { kind: 'chosenOptionIs', value: 'Khans' },
      { kind: 'chosenOptionIs', value: 'Dragons' },
    ]);
    expect(def.triggers[1]).toMatchObject({
      optional: true,
      targets: [{ kind: 'creature', controller: 'opponent' }],
      effects: [{ op: 'fight', first: 'triggerObject', second: 0 }],
    });
  });

  it('frontier-siege-khans-mana — Khans adds {G}{G} at the beginning of each of your main phases only', () => {
    const ctx = pod('siege-khans');
    const self = castSiege(ctx, 'Khans');
    expect(self.chosenOption).toBe('Khans');
    playerById(ctx, 'P1').manaEntries = [];
    mainPhase(ctx, 'P1');
    expect(green(ctx, 'P1')).toBe(2);
    playerById(ctx, 'P1').manaEntries = [];
    mainPhase(ctx, 'P2');
    expect(green(ctx, 'P1')).toBe(0);
    expect(green(ctx, 'P2')).toBe(0);
  });

  it('frontier-siege-khans-after-siege-leaves — a Khans trigger already on the stack still adds {G}{G} after the Siege leaves', () => {
    const ctx = pod('siege-khans-leaves');
    const self = castSiege(ctx, 'Khans');
    playerById(ctx, 'P1').manaEntries = [];
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    queueStepTriggers(ctx, 'mainPhase');
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    resolveTop(ctx);
    // The mode decided which ability triggered; it is not rechecked (CR 113.7a).
    expect(green(ctx, 'P1')).toBe(2);
  });

  it('frontier-siege-dragons-after-siege-leaves — a Dragons trigger already on the stack still lets the flier fight', () => {
    const ctx = pod('siege-dragons-leaves');
    const self = castSiege(ctx, 'Dragons');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', drake());
    pump(priorityCheckpoint(ctx), fightAnswer(true));
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    resolveTop(ctx, fightAnswer(true));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
  });

  it('frontier-siege-dragons-blinked-flier — a flier blinked in response is a new object; the trigger has no "it" to fight', () => {
    const ctx = pod('siege-dragons-blink');
    castSiege(ctx, 'Dragons');
    const victim = spawn(ctx, 'P2', bear());
    const { cardId } = enter(ctx, 'P1', drake());
    pump(priorityCheckpoint(ctx), fightAnswer(true));
    expect(ctx.state.stack).toHaveLength(1);
    const flier = ctx.state.battlefield.find((entry) => entry.cardId === cardId)!;
    pump(moveObject(ctx, flier, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    resolveTop(ctx, fightAnswer(true));
    const returned = ctx.state.battlefield.find((entry) => entry.cardId === cardId)!;
    expect(returned.damageMarked).toBe(0);
    expect(ctx.state.battlefield.find((entry) => entry.id === victim.id)?.damageMarked).toBe(0);
  });

  it('frontier-siege-dragons-fight — Dragons lets an entering flier you control fight a creature you do not control', () => {
    const ctx = pod('siege-dragons');
    castSiege(ctx, 'Dragons');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', drake());
    settle(ctx, fightAnswer(true));
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
    const flier = ctx.state.battlefield.find((entry) => entry.name === 'Siege Drake')!;
    expect(flier.damageMarked).toBe(2);
  });

  it("frontier-siege-dragons-decline-and-filters — declining does nothing; nonfliers, opponents' fliers, and no target never ask", () => {
    const ctx = pod('siege-dragons-filters');
    castSiege(ctx, 'Dragons');
    const victim = spawn(ctx, 'P2', bear());
    enter(ctx, 'P1', drake());
    const declined = settle(ctx, fightAnswer(false));
    expect(declined.decisions.some((d) => d.decisionType === 'optionalTrigger')).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(true);

    enter(ctx, 'P1', bear());
    enter(ctx, 'P2', drake());
    const others = settle(ctx, fightAnswer(true));
    expect(others.decisions.some((d) => d.decisionType === 'optionalTrigger')).toBe(false);

    const lonely = pod('siege-dragons-no-target');
    castSiege(lonely, 'Dragons');
    enter(lonely, 'P1', drake());
    const none = settle(lonely, fightAnswer(true));
    expect(none.decisions.some((d) => d.decisionType === 'optionalTrigger')).toBe(false);
  });

  it('frontier-siege-modes-exclusive — Khans never fights and Dragons never adds mana', () => {
    const khans = pod('siege-khans-only');
    castSiege(khans, 'Khans');
    spawn(khans, 'P2', bear());
    enter(khans, 'P1', drake());
    const fights = settle(khans, fightAnswer(true));
    expect(fights.decisions.some((d) => d.decisionType === 'optionalTrigger')).toBe(false);

    const dragons = pod('siege-dragons-only');
    castSiege(dragons, 'Dragons');
    playerById(dragons, 'P1').manaEntries = [];
    mainPhase(dragons, 'P1');
    expect(green(dragons, 'P1')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.22 Kairi, the Swirling Sky
// ---------------------------------------------------------------------------------------------

describe('Kairi, the Swirling Sky', () => {
  const kairi = pinned('Kairi, the Swirling Sky');
  const rock = (name: string, cost: string) =>
    oracle({ name, typeLine: 'Artifact', manaCost: cost });
  const spellCard = (name: string, type: 'Instant' | 'Sorcery') =>
    oracle({ name, typeLine: type, manaCost: '{1}', oracleText: 'Draw a card.' });
  const BOUNCE = /^Return any number of target nonland permanents/;
  const MILL = /^Mill six cards/;
  const CHOOSE = /choose (a|another) target/i;
  const RETURN = /Kairi: choose instant\/sorcery card/;

  /** Kairi dies; `mode` picks the mode and `rest` answers what follows. */
  function dies(ctx: GameContext, mode: RegExp, rest: Answer) {
    const self = spawn(ctx, 'P1', kairi.card);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    return settle(ctx, (decision, count) =>
      decision.options.some((option) => BOUNCE.test(option.description))
        ? optionMatching(decision, mode)
        : rest(decision, count),
    ).decisions;
  }

  /** Pick each named permanent for the count slot in order, then stop. */
  const pick =
    (...names: string[]): Answer =>
    (decision) => {
      if (CHOOSE.test(decision.prompt)) {
        const next = names.shift();
        return next === undefined
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${next}$`));
      }
      return { index: 0, targets: new Map() };
    };

  const offeredTargets = (decisions: PendingDecision[]) =>
    decisions
      .filter((decision) => CHOOSE.test(decision.prompt))
      .map((decision) => decision.options.map((option) => option.description));

  it('kairi-the-swirling-sky-pinned-oracle-supported — pins the Oracle and models flying, ward, and the modal dies trigger', () => {
    expect(kairi.sha256).toBe('c157c1c01986c4c86651ae7c3cb70dfd09daf80ea13f016e3b0b1a351a020bcf');
    const def = interpretCard(kairi.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toContain('flying');
    expect(def.ward).toMatchObject({ kind: 'mana', cost: expect.objectContaining({ generic: 3 }) });
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]?.targets).toEqual([
      expect.objectContaining({ count: { min: 0, max: Infinity }, totalManaValueAtMost: 6 }),
    ]);
    expect(def.triggers[0]?.modes?.options.map((option) => option.effects)).toEqual([
      [{ op: 'returnToHandEachChosen', targetSlot: 0 }],
      [{ op: 'millAndReturnSpells' }],
    ]);
    expect(def.triggers[0]?.modes?.options.map((option) => option.targetSlots)).toEqual([[0], []]);
  });

  it('kairi-the-swirling-sky-budget-rechecked-on-resolution — targets whose total grew past 6 in response are not returned', () => {
    const ctx = pod('kairi-budget-recheck');
    const idol = spawn(ctx, 'P2', rock('Kairi Idol', '{3}'));
    const totem = spawn(ctx, 'P3', rock('Kairi Totem', '{3}'));
    const self = spawn(ctx, 'P1', kairi.card);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    const choose = pick('Kairi Idol', 'Kairi Totem');
    pump(priorityCheckpoint(ctx), (decision, count) =>
      decision.options.some((option) => BOUNCE.test(option.description))
        ? optionMatching(decision, BOUNCE)
        : choose(decision, count),
    );
    expect(ctx.state.stack).toHaveLength(1);
    // In response the Idol becomes a seven-mana permanent (a copy effect, simulated here by
    // switching its definition): 7 + 3 is past the budget of 6.
    const seven = interpretCard(rock('Kairi Colossus', '{7}'));
    ctx.defs.set(seven.oracleId, seven);
    idol.oracleId = seven.oracleId;
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === idol.id)).toBe(true);
    expect(ctx.state.battlefield.some((entry) => entry.id === totem.id)).toBe(true);
  });

  it('kairi-the-swirling-sky-copy-token-mana-value — a token copy of a seven-mana permanent counts as seven and is never offered', () => {
    const ctx = pod('kairi-copy-token');
    const colossus = spawn(ctx, 'P2', rock('Kairi Colossus', '{7}'));
    spawn(ctx, 'P2', rock('Kairi Trinket', '{1}'));
    pump(
      executeAbility(
        ctx,
        {
          cardId: colossus.cardId,
          oracleId: colossus.oracleId,
          name: colossus.name,
          controllerId: 'P2',
        },
        {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'createTokenCopyOf', ref: 'source', count: { kind: 'const', n: 1 } }],
        },
        [],
      ),
    );
    const copy = ctx.state.battlefield.find(
      (entry) => entry.isToken && entry.name === 'Kairi Colossus',
    );
    expect(copy).toBeDefined();
    // The copy shows the copied cost on the board too, so players can see why it is excluded.
    expect(copy!.manaCost).toBe('{7}');
    const decisions = dies(ctx, BOUNCE, pick('Kairi Trinket'));
    const offered = offeredTargets(decisions).flat();
    // A copy copies the mana cost (CR 707.2): neither Colossus fits a total of 6.
    expect(offered).toContain('Target Kairi Trinket');
    expect(offered).not.toContain('Target Kairi Colossus');
  });

  it('kairi-the-swirling-sky-copied-back-face-mana-value-zero — a token copy of a back face has mana value 0, not the front face cost', () => {
    const ctx = pod('kairi-copy-back-face');
    const brigidCard = (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'),
          'utf8',
        ),
      ) as OracleCard[]
    ).find((card) => card.name.startsWith('Brigid, Clachan'))!;
    const brigid = spawn(ctx, 'P2', brigidCard);
    const copyOf = (perm: EnginePermanent) => {
      pump(
        executeAbility(
          ctx,
          { cardId: perm.cardId, oracleId: perm.oracleId, name: perm.name, controllerId: 'P2' },
          {
            kind: 'spell',
            targets: [],
            effects: [{ op: 'createTokenCopyOf', ref: 'source', count: { kind: 'const', n: 1 } }],
          },
          [],
        ),
      );
      return ctx.state.battlefield.filter((entry) => entry.isToken).at(-1)!;
    };
    // Front face up: the copy carries the front face's mana value.
    expect(permanentManaValue(ctx, copyOf(brigid))).toBe(3);
    // Back face up: the permanent itself keeps the front face's mana value (CR 712.8e), but a
    // copy of the back face has mana value 0 (CR 202.3b).
    expect(transformPermanent(ctx, brigid)).toBe(true);
    expect(permanentManaValue(ctx, brigid)).toBe(3);
    const backCopy = copyOf(brigid);
    expect(permanentManaValue(ctx, backCopy)).toBe(0);
    expect(backCopy.manaCost).toBeNull();
  });

  it('kairi-the-swirling-sky-bounce-total-six — returns chosen nonland permanents to their owners while their mana values total 6 or less', () => {
    const ctx = pod('kairi-bounce');
    spawn(ctx, 'P2', rock('Kairi Idol', '{3}'));
    spawn(ctx, 'P3', rock('Kairi Totem', '{3}'));
    spawn(ctx, 'P2', rock('Kairi Trinket', '{1}'));
    const decisions = dies(ctx, BOUNCE, pick('Kairi Idol', 'Kairi Totem', 'Kairi Trinket'));
    const offered = offeredTargets(decisions);
    // Idol and Totem spend the whole budget, so no third choice is ever asked.
    expect(offered).toHaveLength(2);
    expect(playerById(ctx, 'P2').hand.map((card) => card.name)).toEqual(['Kairi Idol']);
    expect(playerById(ctx, 'P3').hand.map((card) => card.name)).toEqual(['Kairi Totem']);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Kairi Trinket')).toBe(true);
  });

  it('kairi-the-swirling-sky-budget-and-filter — over-budget permanents and lands are never offered; tokens fit for free', () => {
    const ctx = pod('kairi-budget');
    spawn(ctx, 'P2', rock('Kairi Colossus', '{7}'));
    spawn(ctx, 'P2', rock('Kairi Idol', '{4}'));
    spawn(ctx, 'P2', rock('Kairi Totem', '{3}'));
    spawn(ctx, 'P2', rock('Kairi Charm', '{2}'));
    spawn(ctx, 'P2', forest());
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Kairi Spirit', typeLine: 'Creature — Spirit', manaCost: null }),
      { isToken: true },
    );
    const decisions = dies(ctx, BOUNCE, pick('Kairi Idol', 'Kairi Charm', 'Kairi Spirit'));
    const offered = offeredTargets(decisions);
    expect(offered[0]).not.toContain('Target Kairi Colossus');
    expect(offered[0]).not.toContain('Target Forest');
    expect(offered[1]).not.toContain('Target Kairi Totem');
    expect(offered[1]).toContain('Target Kairi Charm');
    expect(offered[2]).toEqual(['Target Kairi Spirit', 'Choose no more targets']);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Kairi Spirit')).toBe(false);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Kairi Totem')).toBe(true);
  });

  it('kairi-the-swirling-sky-bounce-zero — the bounce mode may choose no target at all', () => {
    const ctx = pod('kairi-zero');
    const kept = spawn(ctx, 'P2', rock('Kairi Idol', '{3}'));
    dies(ctx, BOUNCE, pick());
    expect(ctx.state.battlefield.some((entry) => entry.id === kept.id)).toBe(true);
  });

  it('kairi-the-swirling-sky-mill-and-return — mills six, then returns up to two instant or sorcery cards', () => {
    const ctx = pod('kairi-mill');
    const p1 = playerById(ctx, 'P1');
    p1.library = [];
    for (const card of [
      spellCard('Kairi Bolt', 'Instant'),
      forest(),
      spellCard('Kairi Wave', 'Sorcery'),
      spellCard('Kairi Insight', 'Instant'),
      forest(),
      forest(),
      forest(),
    ]) {
      conjure(ctx, 'P1', card, 'library');
    }
    p1.library.reverse();
    // A nonland permanent is on the battlefield, yet the mill mode announces no target.
    spawn(ctx, 'P2', rock('Kairi Idol', '{3}'));
    let picks = 0;
    const decisions = dies(ctx, MILL, (decision) =>
      RETURN.test(decision.prompt)
        ? optionMatching(decision, picks++ === 0 ? /Return Kairi Bolt/ : /Return Kairi Wave/)
        : { index: 0, targets: new Map() },
    );
    expect(p1.library).toHaveLength(1);
    expect(p1.hand.map((card) => card.name).sort()).toEqual(['Kairi Bolt', 'Kairi Wave']);
    expect(p1.graveyard.map((card) => card.name)).toContain('Kairi Insight');
    expect(ctx.state.eventLog.filter((event) => event.type === 'mill')).toHaveLength(6);
    expect(decisions.some((decision) => CHOOSE.test(decision.prompt))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.23 Will of the Mardu
// ---------------------------------------------------------------------------------------------

describe('Will of the Mardu', () => {
  const will = pinned('Will of the Mardu');
  const general = () =>
    oracle({ name: 'Mardu General', typeLine: 'Legendary Creature — Orc', manaCost: '{3}' });

  const castOptions = (ctx: GameContext, objectId: string) =>
    priorityOptions(ctx, 'P1').filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === objectId;
    });
  const modesOf = (option: { payload?: unknown }) => {
    const payload = option.payload as { mode?: number; modes?: number[] };
    return payload.modes ?? (payload.mode === undefined ? [] : [payload.mode]);
  };

  function setup(seed: string) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', will.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'W' }, { symbol: 'W' }]);
    return { ctx, inHand };
  }

  /** Cast with exactly `modes`, filling slot 0 (player) and/or slot 1 (creature). */
  function cast(
    ctx: GameContext,
    inHand: { id: string },
    modes: number[],
    targets: Map<number, string>,
  ) {
    const option = castOptions(ctx, inHand.id).find(
      (candidate) => JSON.stringify(modesOf(candidate)) === JSON.stringify(modes),
    );
    expect(option, JSON.stringify(modes)).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload, undefined, targets);
    resolveTop(ctx);
  }

  const warriors = (ctx: GameContext) =>
    ctx.state.battlefield.filter(
      (entry) => entry.name === 'Warrior' && entry.controllerId === 'P1',
    );

  it('will-of-the-mardu-pinned-oracle-supported — pins the Oracle and models both modes and the any-commander choose-both rider', () => {
    expect(will.sha256).toBe('282fc2b19d0d9b74ca39e2fdeeaee0e14de5314c02b3dba2cde7f55bfc813e5e');
    const def = interpretCard(will.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.modes).toMatchObject({
      minChoices: 1,
      maxChoices: 1,
      maxChoicesIf: { condition: { kind: 'controlsACommander' }, maxChoices: 2 },
    });
    expect(def.spellAbility?.modes?.options.map((option) => option.targetSlots)).toEqual([
      [0],
      [1],
    ]);
  });

  it('will-of-the-mardu-warriors — makes one 1/1 red Warrior per creature the target player controls', () => {
    const { ctx, inHand } = setup('mardu-warriors');
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', bear());
    cast(ctx, inHand, [0], new Map([[0, 'P2']]));
    expect(warriors(ctx)).toHaveLength(3);
    const c = computeCharacteristics(ctx, warriors(ctx)[0]!);
    expect([c.power, c.toughness, c.colors]).toEqual([1, 1, ['R']]);
  });

  it('will-of-the-mardu-damage — deals damage equal to the number of creatures you control', () => {
    const { ctx, inHand } = setup('mardu-damage');
    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    const victim = spawn(
      ctx,
      'P2',
      oracle({ name: 'Mardu Rival', typeLine: 'Creature — Orc', power: '3', toughness: '3' }),
    );
    cast(ctx, inHand, [1], new Map([[1, victim.id]]));
    expect(victim.damageMarked).toBe(2);
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(true);
  });

  it('will-of-the-mardu-choose-both-needs-a-commander — no commander: one mode only; your own or a stolen commander: both', () => {
    const none = setup('mardu-none');
    spawn(none.ctx, 'P2', bear());
    expect(castOptions(none.ctx, none.inHand.id).map(modesOf)).toEqual([[0], [1]]);

    const own = setup('mardu-own');
    spawn(own.ctx, 'P2', bear());
    spawn(own.ctx, 'P1', general()).isCommander = true;
    expect(castOptions(own.ctx, own.inHand.id).map(modesOf)).toContainEqual([0, 1]);

    const stolen = setup('mardu-stolen');
    const theirs = spawn(stolen.ctx, 'P2', general());
    theirs.isCommander = true;
    theirs.controllerId = 'P1';
    expect(castOptions(stolen.ctx, stolen.inHand.id).map(modesOf)).toContainEqual([0, 1]);

    const lost = setup('mardu-lost');
    spawn(lost.ctx, 'P2', bear());
    const mine = spawn(lost.ctx, 'P1', general());
    mine.isCommander = true;
    mine.controllerId = 'P2';
    expect(castOptions(lost.ctx, lost.inHand.id).map(modesOf)).not.toContainEqual([0, 1]);
  });

  it('will-of-the-mardu-both-in-order — with both modes the Warriors arrive first and count toward the damage', () => {
    const { ctx, inHand } = setup('mardu-both');
    spawn(ctx, 'P1', general()).isCommander = true;
    for (let i = 0; i < 2; i++) spawn(ctx, 'P2', bear());
    const victim = spawn(
      ctx,
      'P2',
      oracle({ name: 'Mardu Rival', typeLine: 'Creature — Orc', power: '5', toughness: '5' }),
    );
    cast(
      ctx,
      inHand,
      [0, 1],
      new Map([
        [0, 'P2'],
        [1, victim.id],
      ]),
    );
    expect(warriors(ctx)).toHaveLength(3);
    // The general plus three new Warriors: four creatures, so four damage.
    expect(victim.damageMarked).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.24 Aether Channeler
// ---------------------------------------------------------------------------------------------

describe('Aether Channeler', () => {
  const channeler = pinned('Aether Channeler');
  const relic = () => oracle({ name: 'Channel Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const MODE = /Bird creature token/;

  const modeOptions = (decisions: PendingDecision[]) =>
    decisions
      .find((decision) => decision.options.some((option) => MODE.test(option.description)))
      ?.options.map((option) => option.description) ?? [];

  /** Cast the Channeler from P1's hand and settle, choosing `mode` and answering targets. */
  function castChanneler(ctx: GameContext, mode: RegExp, targetId?: string) {
    const inHand = conjure(ctx, 'P1', channeler.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'U' }, { symbol: 'U' }, { symbol: 'U' }]);
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    let offered: string[] = [];
    const { decisions } = settle(ctx, (decision) => {
      if (decision.options.some((option) => MODE.test(option.description))) {
        return optionMatching(decision, mode);
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        offered = slot.options;
        return { index: 0, targets: new Map([[slot.slot, targetId ?? slot.options[0]!]]) };
      }
      return { index: 0, targets: new Map() };
    });
    return { decisions, offered };
  }

  it('aether-channeler-pinned-oracle-supported — pins the Oracle and models the three-mode enters trigger', () => {
    expect(channeler.sha256).toBe(
      '340f9c527f82807166ad11f5929dc8ddc727045317a5039a8bdaa6848d967ec1',
    );
    const def = interpretCard(channeler.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]?.modes?.options.map((option) => option.targetSlots)).toEqual([
      [],
      [0],
      [],
    ]);
  });

  it('aether-channeler-bird — the Bird mode creates a 1/1 white flying Bird', () => {
    const ctx = pod('channeler-bird');
    castChanneler(ctx, /^Create a 1\/1 white Bird/);
    const bird = ctx.state.battlefield.find((entry) => entry.name === 'Bird')!;
    const c = computeCharacteristics(ctx, bird);
    expect([c.power, c.toughness, c.colors, c.keywords]).toEqual([1, 1, ['W'], ['flying']]);
  });

  it('aether-channeler-bounce-another — returns another target nonland permanent to its owner; never itself or a land', () => {
    const ctx = pod('channeler-bounce');
    const theirs = spawn(ctx, 'P2', relic());
    const mine = spawn(ctx, 'P1', bear());
    const land = spawn(ctx, 'P2', forest());
    const { offered } = castChanneler(ctx, /^Return another target/, theirs.id);
    expect(offered).toContain(mine.id);
    const self = ctx.state.battlefield.find((entry) => entry.name === 'Aether Channeler')!;
    expect(offered).toContain(theirs.id);
    expect(offered).not.toContain(self.id);
    expect(offered).not.toContain(land.id);
    expect(playerById(ctx, 'P2').hand.map((card) => card.name)).toEqual(['Channel Relic']);
  });

  it('aether-channeler-draw — the draw mode draws one card', () => {
    const ctx = pod('channeler-draw');
    const before = playerById(ctx, 'P1').hand.length;
    castChanneler(ctx, /^Draw a card$/);
    expect(playerById(ctx, 'P1').hand.length).toBe(before + 1);
  });

  it('aether-channeler-bounce-needs-another — with no other nonland permanent the bounce mode is not offered', () => {
    const ctx = pod('channeler-alone');
    spawn(ctx, 'P2', forest());
    const { decisions } = castChanneler(ctx, /^Draw a card$/);
    expect(modeOptions(decisions)).toEqual([
      'Create a 1/1 white Bird creature token with flying',
      'Draw a card',
    ]);
  });

  it('aether-channeler-another-excludes-source-on-activations — "another target" never offers the source itself', () => {
    const ctx = pod('another-activation');
    const untapper = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Untapper',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{T}: Untap another target permanent.',
      }),
    );
    const other = spawn(ctx, 'P1', forest(), { tapped: true });
    const option = activationOf(ctx, 'P1', untapper);
    expect(option?.targets?.[0]?.options).toContain(other.id);
    expect(option?.targets?.[0]?.options).not.toContain(untapper.id);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.25 Return to Nature
// ---------------------------------------------------------------------------------------------

describe('Return to Nature', () => {
  const nature = pinned('Return to Nature');
  const relic = () => oracle({ name: 'Nature Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const charm = () => oracle({ name: 'Nature Charm', typeLine: 'Enchantment', manaCost: '{1}' });

  const castOptions = (ctx: GameContext, objectId: string) =>
    priorityOptions(ctx, 'P1').filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === objectId;
    });
  const modesOf = (option: { payload?: unknown }) => {
    const payload = option.payload as { mode?: number; modes?: number[] };
    return payload.modes ?? (payload.mode === undefined ? [] : [payload.mode]);
  };

  function setup(seed: string) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', nature.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    return { ctx, inHand };
  }

  function cast(
    ctx: GameContext,
    inHand: { id: string },
    mode: number,
    slot: number,
    target: string,
  ) {
    const option = castOptions(ctx, inHand.id).find(
      (candidate) => JSON.stringify(modesOf(candidate)) === JSON.stringify([mode]),
    );
    expect(option, `mode ${mode}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[slot, target]]),
    );
  }

  it('return-to-nature-pinned-oracle-supported — pins the Oracle and models three single-target modes', () => {
    expect(nature.sha256).toBe('fabfad3d3c71353543dc51eba22fda33136e020c811fd4d553b2dcace2fa28a0');
    const def = interpretCard(nature.card);
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.modes?.options.map((option) => option.targetSlots)).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it('return-to-nature-destroy-artifact — the first mode destroys the target artifact', () => {
    const { ctx, inHand } = setup('nature-artifact');
    const target = spawn(ctx, 'P2', relic());
    cast(ctx, inHand, 0, 0, target.id);
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Nature Relic']);
  });

  it('return-to-nature-destroy-enchantment — the second mode destroys the target enchantment', () => {
    const { ctx, inHand } = setup('nature-enchantment');
    const target = spawn(ctx, 'P3', charm());
    cast(ctx, inHand, 1, 1, target.id);
    resolveTop(ctx);
    expect(playerById(ctx, 'P3').graveyard.map((card) => card.name)).toEqual(['Nature Charm']);
  });

  it('return-to-nature-exile-graveyard-card — the third mode exiles a card from any graveyard', () => {
    const { ctx, inHand } = setup('nature-graveyard');
    const buried = conjure(ctx, 'P4', bear(), 'graveyard');
    cast(ctx, inHand, 2, 2, buried.id);
    resolveTop(ctx);
    expect(playerById(ctx, 'P4').graveyard).toEqual([]);
    expect(ctx.state.exile.some((card) => card.cardId === buried.cardId)).toBe(true);
  });

  it('return-to-nature-modes-need-only-their-own-target — only modes with a legal target are offered; with none it cannot be cast', () => {
    const graveyardOnly = setup('nature-only-graveyard');
    conjure(graveyardOnly.ctx, 'P2', bear(), 'graveyard');
    expect(castOptions(graveyardOnly.ctx, graveyardOnly.inHand.id).map(modesOf)).toEqual([[2]]);

    const artifactOnly = setup('nature-only-artifact');
    spawn(artifactOnly.ctx, 'P2', relic());
    expect(castOptions(artifactOnly.ctx, artifactOnly.inHand.id).map(modesOf)).toEqual([[0]]);

    const nothing = setup('nature-nothing');
    expect(castOptions(nothing.ctx, nothing.inHand.id)).toEqual([]);
  });

  it("return-to-nature-target-gone-fizzles — if the chosen mode's target leaves, nothing happens", () => {
    const { ctx, inHand } = setup('nature-fizzle');
    const target = spawn(ctx, 'P2', relic());
    const bystander = spawn(ctx, 'P2', charm());
    cast(ctx, inHand, 0, 0, target.id);
    pump(moveObject(ctx, target, { zone: 'exile' }));
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.id === bystander.id)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.26 Mystic Sanctuary
// ---------------------------------------------------------------------------------------------

describe('Mystic Sanctuary', () => {
  const sanctuary = pinned('Mystic Sanctuary');
  const island = () =>
    oracle({
      name: 'Island',
      typeLine: 'Basic Land — Island',
      manaCost: null,
      oracleText: '({T}: Add {U}.)',
    });
  const dualIsland = () =>
    oracle({
      name: 'Sanctuary Strait',
      typeLine: 'Land — Island Swamp',
      manaCost: null,
      oracleText: '({T}: Add {U} or {B}.)',
    });
  const bolt = () =>
    oracle({
      name: 'Sanctuary Bolt',
      typeLine: 'Instant',
      manaCost: '{R}',
      oracleText: 'Draw a card.',
    });

  /** Play Mystic Sanctuary from P1's hand as the land drop, with `islands` already out. */
  function playSanctuary(ctx: GameContext, islands: OracleCard[]) {
    for (const land of islands) spawn(ctx, 'P1', land);
    const inHand = conjure(ctx, 'P1', sanctuary.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(play).toBeDefined();
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    return ctx.state.battlefield.find((entry) => entry.name === 'Mystic Sanctuary')!;
  }

  const accept =
    (yes: boolean, target?: string): Answer =>
    (decision) => {
      if (decision.decisionType === 'optionalTrigger') {
        return optionMatching(decision, yes ? /^Yes$/ : /^No$/);
      }
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined && target !== undefined) {
        return { index: 0, targets: new Map([[slot.slot, target]]) };
      }
      return { index: 0, targets: new Map() };
    };

  it('mystic-sanctuary-pinned-oracle-supported — pins the Oracle and models the conditional entry and the untapped-entry trigger', () => {
    expect(sanctuary.sha256).toBe(
      'e893509bf714c1d47fb25d292a62e3a3c8a39c7d40915c5f97d1fcabea94688e',
    );
    const def = interpretCard(sanctuary.card);
    expect(def.modeled).toBe(true);
    expect(def.subtypes).toContain('Island');
    expect(def.manaAbilities).toEqual([expect.objectContaining({ units: [['U']] })]);
    expect(def.entersTappedUnless).toEqual({
      kind: 'countPermanents',
      selector: { kind: 'subtype', value: 'Island' },
      scope: 'you',
      cmp: '>=',
      n: 3,
    });
    expect(def.triggers[0]).toMatchObject({
      optional: true,
      trigger: { when: 'enters', entersUntapped: true },
      effects: [{ op: 'graveyardToLibraryTop', target: 0 }],
    });
  });

  it('mystic-sanctuary-enters-tapped — with two other Islands it enters tapped and nothing triggers', () => {
    const ctx = pod('sanctuary-tapped');
    conjure(ctx, 'P1', bolt(), 'graveyard');
    const self = playSanctuary(ctx, [island(), island()]);
    expect(self.tapped).toBe(true);
    const { decisions } = settle(ctx, accept(true));
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('mystic-sanctuary-untapped-returns-spell — with three other Islands (any Island) it enters untapped and may put an instant on top', () => {
    const ctx = pod('sanctuary-untapped');
    const spell = conjure(ctx, 'P1', bolt(), 'graveyard');
    const self = playSanctuary(ctx, [island(), island(), dualIsland()]);
    expect(self.tapped).toBe(false);
    settle(ctx, accept(true, spell.id));
    expect(playerById(ctx, 'P1').library[0]?.cardId).toBe(spell.cardId);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
  });

  it('mystic-sanctuary-decline — answering no leaves the graveyard alone', () => {
    const ctx = pod('sanctuary-decline');
    const spell = conjure(ctx, 'P1', bolt(), 'graveyard');
    playSanctuary(ctx, [island(), island(), island()]);
    settle(ctx, accept(false, spell.id));
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).toEqual([spell.cardId]);
  });

  it('mystic-sanctuary-tapped-in-response — "enters untapped" is part of the event, so tapping it in response does not cancel', () => {
    const ctx = pod('sanctuary-response');
    const spell = conjure(ctx, 'P1', bolt(), 'graveyard');
    const self = playSanctuary(ctx, [island(), island(), island()]);
    pump(priorityCheckpoint(ctx), accept(true, spell.id));
    expect(ctx.state.stack).toHaveLength(1);
    self.tapped = true;
    resolveTop(ctx, accept(true, spell.id));
    expect(playerById(ctx, 'P1').library[0]?.cardId).toBe(spell.cardId);
  });

  it("mystic-sanctuary-targets-own-instants-and-sorceries — creature cards and opponents' graveyards are not targets", () => {
    const ctx = pod('sanctuary-targets');
    conjure(ctx, 'P1', bear(), 'graveyard');
    conjure(ctx, 'P2', bolt(), 'graveyard');
    playSanctuary(ctx, [island(), island(), island()]);
    const { decisions } = settle(ctx, accept(true));
    expect(decisions.some((decision) => decision.decisionType === 'optionalTrigger')).toBe(false);
    expect(ctx.state.stack).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.27 Brokers Hideout
// ---------------------------------------------------------------------------------------------

describe('Brokers Hideout', () => {
  const hideout = pinned('Brokers Hideout');
  const basic = (name: string, type: string, symbol: string) =>
    oracle({
      name,
      typeLine: `Basic Land — ${type}`,
      manaCost: null,
      oracleText: `({T}: Add {${symbol}}.)`,
    });
  const grove = () =>
    oracle({
      name: 'Hideout Grove',
      typeLine: 'Land — Forest',
      manaCost: null,
      oracleText: '({T}: Add {G}.)',
    });
  const SEARCH = /search your library/i;

  /** Play Brokers Hideout as P1's land drop with `library` cards on top of a Forest library. */
  function play(seed: string, library: OracleCard[]) {
    const ctx = pod(seed);
    for (const card of library) conjure(ctx, 'P1', card, 'library');
    const inHand = conjure(ctx, 'P1', hideout.card, 'hand');
    const option = priorityOptions(ctx, 'P1').find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    return ctx;
  }

  it('brokers-hideout-pinned-oracle-supported — pins the Oracle and models the sacrifice with a reflexive search', () => {
    expect(hideout.sha256).toBe('9bb13d41853e16160f5e38c4c1470a7b91403284e0e1306f001227d86a7435d5');
    const def = interpretCard(hideout.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.effects).toEqual([
      expect.objectContaining({ op: 'sacrificeSourceThenReflexive' }),
    ]);
  });

  it('brokers-hideout-reflexive-search — it sacrifices itself, then a separate trigger fetches a basic tapped, shuffles, and gains 1 life', () => {
    const ctx = play('hideout-search', [
      basic('Plains', 'Plains', 'W'),
      basic('Island', 'Island', 'U'),
    ]);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.name === 'Brokers Hideout')).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(['Brokers Hideout']);
    // The search is its own ability on the stack, after a priority window (CR 603.12).
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const life = playerById(ctx, 'P1').life;
    resolveTop(ctx, answers([[SEARCH, /Put Plains onto the battlefield tapped/]]));
    const plains = ctx.state.battlefield.find((entry) => entry.name === 'Plains');
    expect(plains?.tapped).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(life + 1);
    const types = ctx.state.eventLog.map((event) => event.type);
    expect(types.lastIndexOf('shuffle')).toBeGreaterThan(types.indexOf('searchFound'));
  });

  it('brokers-hideout-basic-forest-plains-island-only — Swamps and nonbasic Forests are never offered', () => {
    const ctx = play('hideout-filter', [
      basic('Swamp', 'Swamp', 'B'),
      grove(),
      basic('Island', 'Island', 'U'),
    ]);
    const { decisions } = settle(
      ctx,
      answers([[SEARCH, /Put Island onto the battlefield tapped/]]),
    );
    const search = decisions.find((decision) => SEARCH.test(decision.prompt))!;
    const offered = search.options.map((option) => option.description).join('|');
    expect(offered).toContain('Island');
    expect(offered).toContain('Forest');
    expect(offered).not.toContain('Swamp');
    expect(offered).not.toContain('Hideout Grove');
  });

  it('brokers-hideout-find-nothing — finding nothing still shuffles and gains 1 life', () => {
    const ctx = play('hideout-nothing', []);
    const life = playerById(ctx, 'P1').life;
    settle(ctx, answers([[SEARCH, /Find nothing/]]));
    expect(playerById(ctx, 'P1').life).toBe(life + 1);
    expect(ctx.state.eventLog.some((event) => event.type === 'searchFound')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('brokers-hideout-not-sacrificed-no-search — if it already left, nothing is sacrificed and nothing triggers', () => {
    const ctx = play('hideout-gone', []);
    pump(priorityCheckpoint(ctx));
    const self = ctx.state.battlefield.find((entry) => entry.name === 'Brokers Hideout')!;
    pump(moveObject(ctx, self, { zone: 'exile' }));
    const life = playerById(ctx, 'P1').life;
    resolveTop(ctx);
    const { decisions } = settle(ctx, answers([[SEARCH, /Find nothing/]]));
    expect(decisions.some((decision) => SEARCH.test(decision.prompt))).toBe(false);
    expect(playerById(ctx, 'P1').life).toBe(life);
  });

  it('brokers-hideout-blinked-in-response — a Hideout that left and returned is a new object; the old trigger does not sacrifice it', () => {
    const ctx = play('hideout-blink', [basic('Island', 'Island', 'U')]);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    const self = ctx.state.battlefield.find((entry) => entry.name === 'Brokers Hideout')!;
    pump(moveObject(ctx, self, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === self.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    // The returned Hideout's own enters trigger is still pending; the original resolves first.
    const life = playerById(ctx, 'P1').life;
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((entry) => entry.cardId === self.cardId)).toBe(true);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    expect(playerById(ctx, 'P1').life).toBe(life);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.28 Sweet-Gum Recluse
// ---------------------------------------------------------------------------------------------

describe('Sweet-Gum Recluse', () => {
  const recluse = pinned('Sweet-Gum Recluse');
  const CHOOSE = /choose (a|another) target/i;

  /** A creature that has been on the battlefield since an earlier turn. */
  const veteran = (ctx: GameContext, seat: string, name: string) => {
    const perm = spawn(ctx, seat, oracle({ name, typeLine: 'Creature — Elf' }));
    perm.enteredTurnNumber = ctx.state.turnNumber - 1;
    return perm;
  };

  /** Pick each named creature for the any-number slot in order, then stop. */
  const pick =
    (...names: string[]): Answer =>
    (decision) => {
      if (CHOOSE.test(decision.prompt)) {
        const next = names.shift();
        return next === undefined
          ? optionMatching(decision, /Choose no more targets/)
          : optionMatching(decision, new RegExp(`^Target ${next}$`));
      }
      return { index: 0, targets: new Map() };
    };

  /** Cast the Recluse from P1's hand (cascade finds only lands) and settle with `answer`. */
  function castRecluse(ctx: GameContext, answer: Answer) {
    const inHand = conjure(ctx, 'P1', recluse.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 6 }, () => ({ symbol: 'G' as const })),
    );
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    const { decisions } = settle(ctx, answer);
    return {
      decisions,
      self: ctx.state.battlefield.find((entry) => entry.name === 'Sweet-Gum Recluse')!,
    };
  }

  const offered = (decisions: PendingDecision[]) =>
    decisions
      .filter((decision) => CHOOSE.test(decision.prompt))
      .flatMap((decision) => decision.options.map((option) => option.description));

  it('sweet-gum-recluse-pinned-oracle-supported — pins the Oracle and models flash, cascade, reach, and the any-number counters', () => {
    expect(recluse.sha256).toBe('b7a06140e0022bef19a4a2e2b61c1d72dd7173f61421f1acfe414da5eee7e541');
    const def = interpretCard(recluse.card);
    expect(def.modeled).toBe(true);
    expect(def.keywords).toEqual(expect.arrayContaining(['flash', 'cascade', 'reach']));
    expect(def.triggers[0]?.targets).toEqual([
      { kind: 'creature', filter: { kind: 'enteredThisTurn' }, count: { min: 0, max: Infinity } },
    ]);
    expect(def.triggers[0]?.effects).toEqual([
      { op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 3 },
    ]);
  });

  it('sweet-gum-recluse-counters-on-new-creatures — three counters on each chosen creature that entered this turn, any controller, itself included', () => {
    const ctx = pod('recluse-counters');
    const fresh = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Recluse Rival', typeLine: 'Creature — Elf' }));
    const { self } = castRecluse(ctx, pick('Test Bear', 'Recluse Rival', 'Sweet-Gum Recluse'));
    expect(fresh.counters['+1/+1']).toBe(3);
    expect(theirs.counters['+1/+1']).toBe(3);
    expect(self.counters['+1/+1']).toBe(3);
  });

  it('sweet-gum-recluse-only-this-turn — creatures that entered on an earlier turn are never offered', () => {
    const ctx = pod('recluse-filter');
    const old = veteran(ctx, 'P1', 'Recluse Elder');
    spawn(ctx, 'P1', bear());
    const { decisions } = castRecluse(ctx, pick('Test Bear'));
    expect(offered(decisions)).not.toContain('Target Recluse Elder');
    expect(offered(decisions)).toContain('Target Sweet-Gum Recluse');
    expect(old.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('sweet-gum-recluse-zero-targets — it may choose no creature at all', () => {
    const ctx = pod('recluse-zero');
    const fresh = spawn(ctx, 'P1', bear());
    const { self } = castRecluse(ctx, pick());
    expect(fresh.counters['+1/+1'] ?? 0).toBe(0);
    expect(self.counters['+1/+1'] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 1.29 Kogla, the Titan Ape
// ---------------------------------------------------------------------------------------------

describe('Kogla, the Titan Ape', () => {
  const kogla = pinned('Kogla, the Titan Ape');
  const CHOOSE = /choose (a|another) target/i;
  const relic = (name: string) => oracle({ name, typeLine: 'Artifact', manaCost: '{2}' });
  const charm = (name: string) => oracle({ name, typeLine: 'Enchantment', manaCost: '{1}' });
  const human = (name: string) =>
    oracle({ name, typeLine: 'Creature — Human Soldier', power: '1', toughness: '1' });

  /** Cast Kogla from P1's hand and settle its enters fight, choosing `target` or nothing. */
  function castKogla(ctx: GameContext, target: string | null) {
    const inHand = conjure(ctx, 'P1', kogla.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 6 }, () => ({ symbol: 'G' as const })),
    );
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const { decisions } = settle(ctx, (decision) =>
      CHOOSE.test(decision.prompt)
        ? optionMatching(
            decision,
            target === null ? /Choose no more targets/ : new RegExp(`^Target ${target}$`),
          )
        : { index: 0, targets: new Map() },
    );
    return {
      decisions,
      self: ctx.state.battlefield.find((entry) => entry.name === 'Kogla, the Titan Ape')!,
    };
  }

  it('kogla-the-titan-ape-pinned-oracle-supported — pins the Oracle and models the fight, the attack trigger, and the Human bounce', () => {
    expect(kogla.sha256).toBe('b4db59d3f23bce59cddf085d47b283059f82bea48ef05cd4a0c110961f4f303d');
    const def = interpretCard(kogla.card);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]).toMatchObject({
      targets: [{ kind: 'creature', controller: 'opponent', count: { min: 0, max: 1 } }],
      effects: [{ op: 'fightUpToOneChosen', a: 'source', bSlot: 0 }],
    });
    expect(def.triggers[1]).toMatchObject({
      trigger: { when: 'attacks', defendingPlayerIsEventPlayer: true },
      targets: [{ kind: 'artifactOrEnchantment', controller: 'eventPlayer' }],
    });
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([
      { op: 'returnToHand', target: 0 },
      { op: 'grantKeywordUntilEot', target: 'source', keyword: 'indestructible' },
    ]);
  });

  it('kogla-the-titan-ape-enters-fight — casting it fights the chosen creature you do not control', () => {
    const ctx = pod('kogla-fight');
    const victim = spawn(
      ctx,
      'P2',
      oracle({ name: 'Kogla Rival', typeLine: 'Creature — Ape', power: '3', toughness: '3' }),
    );
    spawn(ctx, 'P1', bear());
    const { decisions, self } = castKogla(ctx, 'Kogla Rival');
    const choice = decisions.find((decision) => CHOOSE.test(decision.prompt))!;
    expect(choice.options.map((option) => option.description)).not.toContain('Target Test Bear');
    expect(ctx.state.battlefield.some((entry) => entry.id === victim.id)).toBe(false);
    expect(self.damageMarked).toBe(3);
  });

  it('kogla-the-titan-ape-blinked-in-response — a Kogla that left and returned is a new object; the old trigger has no "it" to fight', () => {
    const ctx = pod('kogla-blink');
    const rival = spawn(
      ctx,
      'P2',
      oracle({ name: 'Kogla Rival', typeLine: 'Creature — Ape', power: '3', toughness: '3' }),
    );
    const { cardId } = enter(ctx, 'P1', kogla.card);
    const self = ctx.state.battlefield.find((entry) => entry.cardId === cardId)!;
    pump(priorityCheckpoint(ctx), (decision) =>
      CHOOSE.test(decision.prompt)
        ? optionMatching(decision, /^Target Kogla Rival$/)
        : { index: 0, targets: new Map() },
    );
    expect(ctx.state.stack).toHaveLength(1);
    pump(moveObject(ctx, self, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === self.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    resolveTop(ctx);
    const returned = ctx.state.battlefield.find((entry) => entry.cardId === self.cardId)!;
    expect(returned.damageMarked).toBe(0);
    expect(ctx.state.battlefield.find((entry) => entry.id === rival.id)?.damageMarked).toBe(0);
  });

  it('kogla-the-titan-ape-not-a-creature — a Kogla that stopped being a creature fights nothing', () => {
    const ctx = pod('kogla-noncreature');
    const rival = spawn(
      ctx,
      'P2',
      oracle({ name: 'Kogla Rival', typeLine: 'Creature — Ape', power: '3', toughness: '3' }),
    );
    const { cardId } = enter(ctx, 'P1', kogla.card);
    const self = ctx.state.battlefield.find((entry) => entry.cardId === cardId)!;
    pump(priorityCheckpoint(ctx), (decision) =>
      CHOOSE.test(decision.prompt)
        ? optionMatching(decision, /^Target Kogla Rival$/)
        : { index: 0, targets: new Map() },
    );
    // In response, Kogla becomes a noncreature artifact; the Rival is still a legal target.
    ctx.state.effects.push({
      id: 'eff-test-noncreature',
      sourceId: self.cardId,
      description: 'Kogla becomes an artifact',
      targetCardIds: [self.cardId],
      kind: 'becomeCreature',
      duration: 'permanent',
      becomeCreature: {
        replaceTypes: ['Artifact'],
        addSubtypes: [],
        addKeywords: [],
        power: 8,
        toughness: 8,
      },
      timestamp: ctx.state.nextTimestamp++,
    });
    expect(computeCharacteristics(ctx, self).types).not.toContain('Creature');
    resolveTop(ctx);
    // CR 701.14b: neither fights.
    expect(ctx.state.battlefield.find((entry) => entry.id === rival.id)?.damageMarked).toBe(0);
    expect(self.damageMarked).toBe(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'fight')).toBe(false);
  });

  it('kogla-the-titan-ape-up-to-one — it may fight nothing', () => {
    const ctx = pod('kogla-none');
    const kept = spawn(ctx, 'P2', bear());
    const { self } = castKogla(ctx, null);
    expect(ctx.state.battlefield.some((entry) => entry.id === kept.id)).toBe(true);
    expect(self.damageMarked).toBe(0);
  });

  it("kogla-the-titan-ape-attack-destroys-defenders-permanent — only the defending player's artifacts and enchantments are targets", () => {
    const ctx = pod('kogla-attack');
    const self = spawn(ctx, 'P1', kogla.card);
    const relicP3 = spawn(ctx, 'P3', relic('Kogla P3 Relic'));
    spawn(ctx, 'P3', charm('Kogla P3 Charm'));
    const otherPlayers = spawn(ctx, 'P2', relic('Kogla P2 Relic'));
    let offered: string[] = [];
    runCombat(ctx, { [self.id]: 'P3' }, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        offered = slot.options;
        return { index: 0, targets: new Map([[slot.slot, relicP3.id]]) };
      }
      return { index: 0, targets: new Map() };
    });
    expect(offered).toHaveLength(2);
    expect(offered).not.toContain(otherPlayers.id);
    expect(playerById(ctx, 'P3').graveyard.map((card) => card.name)).toContain('Kogla P3 Relic');
    expect(ctx.state.battlefield.some((entry) => entry.id === otherPlayers.id)).toBe(true);
  });

  it("kogla-the-titan-ape-human-bounce — {1}{G} returns a Human you control and Kogla gains indestructible; non-Humans and opponents' Humans are not targets", () => {
    const ctx = pod('kogla-bounce');
    const self = spawn(ctx, 'P1', kogla.card);
    const mine = spawn(ctx, 'P1', human('Kogla Squire'));
    spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', human('Kogla Rival Squire'));
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    const option = activationOf(ctx, 'P1', self);
    expect(option?.targets?.[0]?.options).toEqual([mine.id]);
    expect(option?.targets?.[0]?.options).not.toContain(theirs.id);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, mine.id]]),
    );
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toContain('Kogla Squire');
    expect(computeCharacteristics(ctx, self).keywords).toContain('indestructible');
  });

  it('kogla-the-titan-ape-bounce-blinked-kogla — a Kogla blinked in response is a new object and does not gain indestructible', () => {
    const ctx = pod('kogla-bounce-blink');
    const self = spawn(ctx, 'P1', kogla.card);
    const mine = spawn(ctx, 'P1', human('Kogla Squire'));
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    const option = activationOf(ctx, 'P1', self);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, mine.id]]),
    );
    pump(moveObject(ctx, self, { zone: 'exile' }));
    const card = ctx.state.exile.find((entry) => entry.cardId === self.cardId)!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    resolveTop(ctx);
    // The Human target is still legal, so the ability resolves: the Human returns, but the
    // Kogla it would protect is gone.
    expect(playerById(ctx, 'P1').hand.map((entry) => entry.name)).toContain('Kogla Squire');
    const returned = ctx.state.battlefield.find((entry) => entry.cardId === self.cardId)!;
    expect(computeCharacteristics(ctx, returned).keywords).not.toContain('indestructible');
  });

  it('kogla-the-titan-ape-bounce-fizzles — if the Human leaves first, the ability does nothing at all', () => {
    const ctx = pod('kogla-fizzle');
    const self = spawn(ctx, 'P1', kogla.card);
    const mine = spawn(ctx, 'P1', human('Kogla Squire'));
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, { symbol: 'G' }]);
    const option = activationOf(ctx, 'P1', self);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, mine.id]]),
    );
    pump(moveObject(ctx, mine, { zone: 'exile' }));
    resolveTop(ctx);
    expect(computeCharacteristics(ctx, self).keywords).not.toContain('indestructible');
  });
});

// ---------------------------------------------------------------------------------------------
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
}

/** Cards restored in PR01. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Forum of Amity',
    sha256: 'b49800b6e3d748f53ad05c73cbf239e4c57e16fac1e8288c5fdf8d1f36b384ee',
    clauseCount: 3,
  },
  {
    name: 'Attune with Aether',
    sha256: 'e1dc515b653e7e3f91dda25d2ed30a27208e28a623ab2be3604d643119e57c94',
    clauseCount: 1,
  },
  {
    name: 'Beacon of Unrest',
    sha256: 'e8e9347132f2e3a9e1529d4ac633e47efaa45a78780e6efb21226d155a7c58d4',
    clauseCount: 2,
  },
  {
    name: 'Canoptek Spyder',
    sha256: '53b215a10a556d1e72d4f977805f0cb972b18a035e0e0e3e8d4a9e928b9c5e20',
    clauseCount: 2,
  },
  {
    name: 'Canoptek Wraith',
    sha256: '04d5efb7388c9a8185ee2000da27e3c1fe20e8da9a1061abff8f431729d2e4b2',
    clauseCount: 2,
  },
  {
    name: "Conjurer's Closet",
    sha256: 'd80cdb0f2c13939c9ac36f2137931ba2cd340fb6e524f8906c038be6c7818b2c',
    clauseCount: 1,
  },
  {
    name: 'Harvest Season',
    sha256: '3f013020bdf1351d15c88eff85e1030be7f07537aff30256a911ba95125b7c9f',
    clauseCount: 1,
  },
  {
    name: 'Land Tax',
    sha256: '4b365fab95d5ae332e404759f054d57169911d769d44ef0cbf6890e83ac0d4a7',
    clauseCount: 1,
  },
  {
    name: 'Mordant Dragon',
    sha256: '5f4a39ae0545bf5d50bac488bb58ac3101bb6ac10eeb19f289e2159a39d40552',
    clauseCount: 2,
  },
  {
    name: 'Necron Deathmark',
    sha256: '9ea0d5feb506abd7f1b877e3898f5a1aa655060699a83b69ca1753ef2eb20ae6',
    clauseCount: 2,
  },
  {
    name: 'Plasmancer',
    sha256: '0aedfcf7611280dfaf130e91c553dbc2a0bce3d94f087201255ccd6db34ea22e',
    clauseCount: 2,
  },
  {
    name: 'Sylvan Reclamation',
    sha256: '5682177705c6c6ef5b2dccfc5926514a68168bac41623daea143bf738b440274',
    clauseCount: 2,
  },
  {
    name: 'Thunderfoot Baloth',
    sha256: 'ad245d778eb6fdf24778c3037b47c0b0bb89e80346f64557ce250b39123fb23f',
    clauseCount: 2,
  },
  {
    name: 'Tomb Fortress',
    sha256: '65ac436976204aa19616a5462be74a04d8081dd30adaddfeedfe8b3fcaef5329',
    clauseCount: 3,
  },
  {
    name: 'Voice of Many',
    sha256: '63a689cdc880b92b9c729e38b25e18cdb455d1c284bbd306e20cdb6e8fa787c7',
    clauseCount: 1,
  },
  {
    name: 'Foe-Razer Regent',
    sha256: '538901867581226afa96f2206428146725bae81b91a1120ce5a42696a415e4ea',
    clauseCount: 3,
  },
  {
    name: 'Hunting Wilds',
    sha256: 'b673b9cfa9797a896494a8d2751fe9cce08e1787a1e866d6b8b23ce3b3ba5804',
    clauseCount: 3,
  },
  {
    name: 'Loran of the Third Path',
    sha256: '1113e09d5ae37057a26a4ed71a643206eb4ca8bb572b7116b0107ff2ebdd3454',
    clauseCount: 3,
  },
  {
    name: 'Rishkar, Peema Renegade',
    sha256: 'd0ebd951555eaeb46229fdf0a02a614e3752b215aeafd80d90078ec75008f758',
    clauseCount: 2,
  },
  {
    name: 'Vastwood Surge',
    sha256: '5922182fae289ab48ae49f025ac55977e4bf45975284d4d5b0663666de3fd5f5',
    clauseCount: 2,
  },
  {
    name: 'Frontier Siege',
    sha256: '1b195bc9d7e3f03e803eb4ad56d689fbd073b725d5ce8076b9998e0740982641',
    clauseCount: 3,
  },
  {
    name: 'Kairi, the Swirling Sky',
    sha256: 'c157c1c01986c4c86651ae7c3cb70dfd09daf80ea13f016e3b0b1a351a020bcf',
    clauseCount: 4,
  },
  {
    name: 'Will of the Mardu',
    sha256: '282fc2b19d0d9b74ca39e2fdeeaee0e14de5314c02b3dba2cde7f55bfc813e5e',
    clauseCount: 3,
  },
  {
    name: 'Aether Channeler',
    sha256: '340f9c527f82807166ad11f5929dc8ddc727045317a5039a8bdaa6848d967ec1',
    clauseCount: 4,
  },
  {
    name: 'Return to Nature',
    sha256: 'fabfad3d3c71353543dc51eba22fda33136e020c811fd4d553b2dcace2fa28a0',
    clauseCount: 4,
  },
  {
    name: 'Mystic Sanctuary',
    sha256: 'e893509bf714c1d47fb25d292a62e3a3c8a39c7d40915c5f97d1fcabea94688e',
    clauseCount: 3,
  },
  {
    name: 'Brokers Hideout',
    sha256: '9bb13d41853e16160f5e38c4c1470a7b91403284e0e1306f001227d86a7435d5',
    clauseCount: 1,
  },
  {
    name: 'Sweet-Gum Recluse',
    sha256: 'b7a06140e0022bef19a4a2e2b61c1d72dd7173f61421f1acfe414da5eee7e541',
    clauseCount: 4,
  },
  {
    name: 'Kogla, the Titan Ape',
    sha256: 'b4db59d3f23bce59cddf085d47b283059f82bea48ef05cd4a0c110961f4f303d',
    clauseCount: 3,
  },
];

interface ManifestClause {
  id?: string;
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  viewerScenarioIds: string[];
}

interface Manifest {
  cards: Record<
    string,
    {
      name: string;
      oracleSha256: string;
      implementationStatus: string;
      clauses: ManifestClause[];
      gameplayAiScenarioIds: string[];
    }
  >;
}

const repoFile = (path: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8');

describe('PR01 restoration gate', () => {
  const manifest = JSON.parse(
    repoFile('packages/server/fixtures/card-verification-manifest.json'),
  ) as Manifest;
  const engineSource = readFileSync(import.meta.filename, 'utf8');
  const viewerSource = [
    repoFile('packages/server/src/cards/card-test-scenarios.ts'),
    repoFile('apps/web/e2e/card-test-lab.spec.ts'),
  ].join('\n');

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s is pinned and modeled under its real id and fixture alias',
    (name, expected) => {
      const entry = pinned(name);
      expect(entry.sha256).toBe(expected.sha256);
      expect(createHash('sha256').update(canonical(entry.card)).digest('hex')).toBe(
        expected.sha256,
      );
      for (const candidate of [entry.card, { ...entry.card, oracleId: fixtureOracleId(name) }]) {
        const def = interpretCard(candidate);
        expect(def.unmodeledReasons, `${name} (${candidate.oracleId})`).toEqual([]);
        expect(def.modeled, `${name} (${candidate.oracleId})`).toBe(true);
      }
    },
  );

  it('leaves no registration behind for cards the audit records as interpreter-restored', () => {
    const audit = JSON.parse(repoFile('docs/plans/card-catalog-audit.json')) as {
      interpreterRestored?: { oracleId: string; name: string; restoredIn: string }[];
    };
    const ours = (audit.interpreterRestored ?? []).filter(
      (entry) => entry.restoredIn === 'coverage-pr01',
    );
    for (const entry of ours) {
      expect(
        RESTORED.map((card) => card.name),
        entry.name,
      ).toContain(entry.name);
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      expect(getOverride(fixtureOracleId(entry.name)), `${entry.name} alias`).toBeUndefined();
      expect(interpretCard(pinned(entry.name).card).modeled, entry.name).toBe(true);
    }
  });

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s declares implemented-reviewed clauses mapped to engine and viewer evidence',
    (name, expected) => {
      const entry = pinned(name);
      const declared = manifest.cards[entry.card.oracleId];
      expect(declared?.name).toBe(name);
      expect(declared?.oracleSha256).toBe(expected.sha256);
      expect(declared?.implementationStatus).toBe('implemented-reviewed');
      expect(declared?.clauses).toHaveLength(expected.clauseCount);
      for (const clause of declared!.clauses) {
        expect(clause.id, `${name} clause id`).toBeTruthy();
        expect(entry.card.oracleText, `${name} clause text`).toContain(clause.oracleText);
        expect(clause.implementation, `${name} implementation`).not.toHaveLength(0);
        expect(clause.engineTestIds, `${name} engine tests`).not.toHaveLength(0);
        expect(clause.viewerScenarioIds, `${name} viewer scenarios`).not.toHaveLength(0);
        for (const id of clause.engineTestIds) expect(engineSource, id).toContain(`${id} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Card Test Lab continuations use the production phase transitions
// ---------------------------------------------------------------------------------------------

describe('prepared-scenario continuations', () => {
  const passEverything = (decision: PendingDecision): DecisionOutcome => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  };

  it('prepared-end-step-monarch — continuing to the end step begins it like a real turn, monarch draw included', () => {
    const ctx = pod('prepared-end-step');
    ctx.state.monarchPlayerId = 'P1';
    const spec: PreparedScenarioSpec = {
      currentTurnPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      turnNumber: 3,
      hand: [],
      battlefield: [],
      continueToPostcombatMain: true,
      continueToEndStep: true,
    };
    prepareScenario(ctx, spec);
    const handBefore = playerById(ctx, 'P1').hand.length;
    pump(playPreparedScenario(ctx, spec), passEverything);
    expect(playerById(ctx, 'P1').hand.length).toBe(handBefore + 1);
    const phases = ctx.state.eventLog
      .filter((event) => event.type === 'phaseBegin')
      .map((event) => (event.payload as { phase: string }).phase);
    expect(phases).toEqual(['postcombatMain', 'ending']);
  });
});
