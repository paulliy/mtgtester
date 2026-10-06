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
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { Ability, Effect } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { allOf, ofSupertype, ofType } from '../src/cards/selector';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { formatPlayerLog } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json'];
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
