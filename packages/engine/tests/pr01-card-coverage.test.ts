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
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers, runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
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
    resolveTop(ctx, closetAnswer(null, true));
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
