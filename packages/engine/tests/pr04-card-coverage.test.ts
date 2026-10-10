/**
 * PR04 card coverage: counters and turn history (docs/plans/card-coverage-chunks.md).
 *
 * Each restored card has a `describe` block whose test names start with the engine test IDs the
 * verification manifest declares for it. The gate at the bottom ties the two together: every
 * restored card must be pinned, modeled under both its real Oracle ID and its fixture alias,
 * declared `implemented-unreviewed` in the manifest, and mapped to engine tests in this file and to
 * Card Test Lab scenarios that the real-viewer Playwright spec exercises.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { runTurn } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
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

/** The priority option whose payload object and description match, if it is legal now. */
function optionFor(ctx: GameContext, playerId: string, objectId: string, pattern?: RegExp) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      'objectId' in payload &&
      payload.objectId === objectId &&
      (pattern === undefined || pattern.test(option.description))
    );
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

/** Run a whole turn for the current turn player with nobody attacking or blocking. */
function quietTurn(ctx: GameContext) {
  return pump(runTurn(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, () => null);
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  });
}

/** Move a card from `zone` onto the battlefield through the normal zone change. */
function enterFrom(
  ctx: GameContext,
  controllerId: string,
  card: OracleCard,
  zone: 'hand' | 'graveyard' | 'exile' | 'library',
): EnginePermanent {
  const object = conjure(ctx, controllerId, card, zone);
  pump(moveObject(ctx, object, { zone: 'battlefield', controllerId }));
  return ctx.state.battlefield.find((perm) => perm.cardId === object.cardId)!;
}

const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));
const blue = (n: number) => Array.from({ length: n }, () => ({ symbol: 'U' as const }));
const black = (n: number) => Array.from({ length: n }, () => ({ symbol: 'B' as const }));

/**
 * `playerId` casts `card` from hand through the normal legality/payment path with `mana`, filling
 * target slots from `targets`. The spell is left on the stack, with its cast triggers pending.
 */
function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: { symbol: 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }[],
  targets: ReadonlyMap<number, string> = new Map(),
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(playerById(ctx, playerId), mana);
  const option = optionFor(ctx, playerId, object.id);
  expect(option, `${playerId} casts ${card.name}`).toBeDefined();
  takeAction(ctx, playerId, option!.payload as PriorityActionPayload, undefined, targets);
  return object;
}

/** Put `perm` into its owner's graveyard through the normal single-permanent zone change. */
function kill(ctx: GameContext, perm: EnginePermanent) {
  return pump(moveObject(ctx, perm, { zone: 'graveyard' }));
}

/** The permanent on the battlefield that is this card now, if any. */
function onField(ctx: GameContext, cardId: string) {
  return ctx.state.battlefield.find((perm) => perm.cardId === cardId);
}

/** The pinned card is modeled under both ids with no remaining reasons. */
function expectModeled(card: OracleCard): void {
  for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
    const def = interpretCard(candidate);
    expect(def.unmodeledReasons, candidate.oracleId).toEqual([]);
    expect(def.modeled, candidate.oracleId).toBe(true);
  }
}

/** The fail-closed registration is gone under both ids: the interpreter reads the card. */
function expectNoRegistration(card: OracleCard): void {
  expect(getOverride(card.oracleId)).toBeUndefined();
  expect(getOverride(fixtureOracleId(card.name))).toBeUndefined();
}

const LAB_CARD = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// ---------------------------------------------------------------------------------------------
// PR04.02 Sautekh Immortal
// ---------------------------------------------------------------------------------------------

describe('Sautekh Immortal', () => {
  const { card } = pinned('Sautekh Immortal');
  const VICTIM = LAB_CARD('Lab Victim');

  /** Put `count` creatures into graveyards from the battlefield this turn, alternating owners. */
  function killCreatures(ctx: GameContext, count: number, opts: { token?: boolean } = {}) {
    for (let i = 0; i < count; i++) {
      const victim = spawn(ctx, i % 2 === 0 ? 'P1' : 'P2', VICTIM, {
        isToken: opts.token === true,
      });
      kill(ctx, victim);
    }
  }

  it('sautekh-immortal-pinned-oracle-supported — the interpreter alone models flash and the enters-with replacement', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('flash');
    expect(def.entersWithCounters).toEqual({ '+1/+1': { kind: 'creaturesDiedThisTurn' } });
    // A replacement effect (CR 614.1c), never an enters trigger.
    expect(def.triggers).toEqual([]);
  });

  it('sautekh-immortal-counts-every-death — cast with flash after three creatures died, it enters with three counters', () => {
    const ctx = pod('sautekh-three');
    killCreatures(ctx, 2);
    killCreatures(ctx, 1, { token: true });
    expect(ctx.state.creaturesDiedThisTurn).toBe(3);
    // Flash: cast on an opponent's turn.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    const sautekh = onField(ctx, object.cardId)!;
    expect(sautekh.counters['+1/+1']).toBe(3);
    expect(effectivePT(ctx, sautekh)).toEqual({ power: 5, toughness: 5 });
    // Nothing waits to trigger: the counters were there as it entered.
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('sautekh-immortal-no-deaths — with no creature dead this turn it enters with no counters', () => {
    const ctx = pod('sautekh-none');
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    const sautekh = onField(ctx, object.cardId)!;
    expect(sautekh.counters['+1/+1'] ?? 0).toBe(0);
    expect(effectivePT(ctx, sautekh)).toEqual({ power: 2, toughness: 2 });
  });

  it('sautekh-immortal-counts-as-it-enters — a creature dying while the spell is on the stack is counted', () => {
    const ctx = pod('sautekh-stack');
    killCreatures(ctx, 1);
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    killCreatures(ctx, 1);
    resolveTop(ctx);
    expect(onField(ctx, object.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('sautekh-immortal-any-entry — put onto the battlefield from a graveyard it still enters with the counters', () => {
    const ctx = pod('sautekh-reanimate');
    killCreatures(ctx, 2);
    const sautekh = enterFrom(ctx, 'P1', card, 'graveyard');
    expect(sautekh.counters['+1/+1']).toBe(2);
  });

  it('sautekh-immortal-this-turn-only — deaths from an earlier turn are not counted', () => {
    const ctx = pod('sautekh-next-turn');
    killCreatures(ctx, 2);
    expect(ctx.state.creaturesDiedThisTurn).toBe(2);
    // The game loop hands the turn to P2; that real turn starts the count over.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    quietTurn(ctx);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...black(1)]);
    resolveTop(ctx);
    expect(onField(ctx, object.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.01 Iron Apprentice
// ---------------------------------------------------------------------------------------------

describe('Iron Apprentice', () => {
  const { card } = pinned('Iron Apprentice');
  const ALLY = LAB_CARD('Lab Ally');
  const RIVAL = LAB_CARD('Lab Rival');
  const HARDENED_SCALES = oracle({
    name: 'Hardened Scales',
    typeLine: 'Enchantment',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText:
      'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
  });

  /** Cast it from hand so it enters through the real replacement, then return the permanent. */
  function castApprentice(ctx: GameContext): EnginePermanent {
    const object = castFromHand(ctx, 'P1', card, generic(1));
    resolveTop(ctx);
    return onField(ctx, object.cardId)!;
  }

  /**
   * Kill it and let its dies trigger resolve. Returns the names of every creature offered when
   * there was a choice (a single legal target is chosen without a prompt), choosing `pick`.
   */
  function dieAndSettle(ctx: GameContext, apprentice: EnginePermanent, pick: string) {
    kill(ctx, apprentice);
    const offered: string[] = [];
    const nameOf = (id: string) => ctx.state.battlefield.find((perm) => perm.id === id)?.name;
    settle(ctx, (decision) => {
      if (decision.decisionType !== 'chooseTargets') return { index: 0, targets: new Map() };
      const slot = decision.options[0]!.targets![0]!;
      offered.push(...slot.options.map((id) => nameOf(id) ?? id));
      const chosen = slot.options.find((id) => nameOf(id) === pick);
      return { index: 0, targets: new Map([[slot.slot, chosen!]]) };
    });
    return offered;
  }

  it('iron-apprentice-pinned-oracle-supported — the interpreter alone models the enters-with counter and the counter-gated dies trigger', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.entersWithCounters).toEqual({ '+1/+1': 1 });
    expect(def.triggers).toHaveLength(1);
    const trigger = def.triggers[0]!;
    expect(trigger.trigger).toMatchObject({
      when: 'dies',
      subject: { kind: 'self' },
      condition: { kind: 'sourceMatches', selector: { kind: 'hasAnyCounter' } },
    });
    expect(trigger.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(trigger.effects).toEqual([{ op: 'transferCountersFromSource', target: 0 }]);
  });

  it('iron-apprentice-enters-with-a-counter — cast for {1}, it enters as a 1/1 with a +1/+1 counter', () => {
    const ctx = pod('apprentice-enters');
    const apprentice = castApprentice(ctx);
    expect(apprentice.counters['+1/+1']).toBe(1);
    expect(effectivePT(ctx, apprentice)).toEqual({ power: 1, toughness: 1 });
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('iron-apprentice-dies-moves-every-counter — it dies with three +1/+1 counters and an oil counter, and its target gets all of them', () => {
    const ctx = pod('apprentice-moves');
    const ally = spawn(ctx, 'P1', ALLY);
    const apprentice = castApprentice(ctx);
    apprentice.counters['+1/+1'] = 3;
    apprentice.counters['oil'] = 1;
    dieAndSettle(ctx, apprentice, 'Lab Ally');
    const target = onField(ctx, ally.cardId)!;
    expect(target.counters['+1/+1']).toBe(3);
    expect(target.counters['oil']).toBe(1);
  });

  it('iron-apprentice-no-counters-no-trigger — it dies with no counters on it and nothing triggers', () => {
    const ctx = pod('apprentice-empty');
    spawn(ctx, 'P1', ALLY);
    const apprentice = castApprentice(ctx);
    apprentice.counters['+1/+1'] = 0;
    kill(ctx, apprentice);
    // CR 603.4: the intervening-if is false as it dies, so the ability never triggers.
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('iron-apprentice-only-your-creatures — only creatures you control are offered, never an opponent’s', () => {
    const ctx = pod('apprentice-targets');
    const ally = spawn(ctx, 'P1', ALLY);
    const friend = spawn(ctx, 'P1', LAB_CARD('Lab Friend'));
    const rival = spawn(ctx, 'P2', RIVAL);
    const apprentice = castApprentice(ctx);
    const offered = dieAndSettle(ctx, apprentice, 'Lab Friend');
    expect(offered).toContain('Lab Ally');
    expect(offered).toContain('Lab Friend');
    expect(offered).not.toContain('Lab Rival');
    expect(offered).not.toContain('Iron Apprentice');
    expect(onField(ctx, friend.cardId)!.counters['+1/+1']).toBe(1);
    expect(onField(ctx, ally.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
    expect(onField(ctx, rival.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('iron-apprentice-no-target — with no other creature you control, the counters are simply lost', () => {
    const ctx = pod('apprentice-alone');
    const rival = spawn(ctx, 'P2', RIVAL);
    const apprentice = castApprentice(ctx);
    kill(ctx, apprentice);
    settle(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(onField(ctx, rival.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('iron-apprentice-counter-replacements-apply — Hardened Scales adds one to the +1/+1 counters it puts', () => {
    const ctx = pod('apprentice-scales');
    spawn(ctx, 'P1', HARDENED_SCALES);
    const ally = spawn(ctx, 'P1', ALLY);
    const apprentice = castApprentice(ctx);
    // Scales applied as it entered: 1 + 1.
    expect(apprentice.counters['+1/+1']).toBe(2);
    dieAndSettle(ctx, apprentice, 'Lab Ally');
    expect(onField(ctx, ally.cardId)!.counters['+1/+1']).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.04 Vigean Graftmage
// ---------------------------------------------------------------------------------------------

describe('Vigean Graftmage', () => {
  const { card } = pinned('Vigean Graftmage');
  const NEWCOMER = LAB_CARD('Lab Newcomer');
  const yes = answers([[/use this ability/, /^Yes$/]]);
  const no = answers([[/use this ability/, /^No$/]]);
  const HARDENED_SCALES = oracle({
    name: 'Hardened Scales',
    typeLine: 'Enchantment',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText:
      'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
  });

  /** Cast it from hand so it enters through the real replacement, then return the permanent. */
  function castGraftmage(ctx: GameContext): EnginePermanent {
    const object = castFromHand(ctx, 'P1', card, [...generic(2), ...blue(1)]);
    resolveTop(ctx);
    return onField(ctx, object.cardId)!;
  }

  /** `controllerId`'s creature enters from hand through the normal zone change. */
  function newcomerEnters(ctx: GameContext, controllerId: string): EnginePermanent {
    return enterFrom(ctx, controllerId, NEWCOMER, 'hand');
  }

  it('vigean-graftmage-pinned-oracle-supported — the interpreter alone models Graft 2 and the counter-gated untap', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.entersWithCounters).toEqual({ '+1/+1': 2 });
    expect(def.triggers).toHaveLength(1);
    const graft = def.triggers[0]!;
    expect(graft.optional).toBe(true);
    expect(graft.trigger).toMatchObject({
      when: 'enters',
      subject: { kind: 'permanent', selector: { kind: 'allOf' } },
      // CR 702.58a's intervening-if, which the reminder text leaves out.
      condition: { kind: 'sourceHasCounters', counter: '+1/+1', cmp: '>=', n: 1 },
    });
    expect(graft.effects).toEqual([
      { op: 'moveCounters', from: 'source', to: 'triggerObject', counter: '+1/+1', count: 1 },
    ]);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]!.ability.targets).toEqual([
      { kind: 'creature', filter: { kind: 'hasCounter', counter: '+1/+1' } },
    ]);
  });

  it('vigean-graftmage-enters-with-two — cast for {2}{U}, it enters as a 2/2 with two +1/+1 counters and grafts nothing onto itself', () => {
    const ctx = pod('graftmage-enters');
    const graftmage = castGraftmage(ctx);
    expect(graftmage.counters['+1/+1']).toBe(2);
    expect(effectivePT(ctx, graftmage)).toEqual({ power: 2, toughness: 2 });
    // "another creature": its own entry does not trigger Graft.
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('vigean-graftmage-graft-moves-a-counter — another creature you control enters, and you move one counter onto it', () => {
    const ctx = pod('graftmage-move');
    const graftmage = castGraftmage(ctx);
    const newcomer = newcomerEnters(ctx, 'P1');
    settle(ctx, yes);
    expect(onField(ctx, graftmage.cardId)!.counters['+1/+1']).toBe(1);
    expect(onField(ctx, newcomer.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('vigean-graftmage-graft-any-creature — an opponent’s creature entering triggers it too, and the counter moves onto that creature', () => {
    const ctx = pod('graftmage-opponent');
    const graftmage = castGraftmage(ctx);
    const newcomer = newcomerEnters(ctx, 'P2');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P1']);
    settle(ctx, yes);
    expect(onField(ctx, graftmage.cardId)!.counters['+1/+1']).toBe(1);
    expect(onField(ctx, newcomer.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('vigean-graftmage-graft-may-decline — declining the move leaves both counters where they are', () => {
    const ctx = pod('graftmage-decline');
    const graftmage = castGraftmage(ctx);
    const newcomer = newcomerEnters(ctx, 'P1');
    settle(ctx, no);
    expect(onField(ctx, graftmage.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, newcomer.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('vigean-graftmage-graft-needs-a-counter — with no +1/+1 counter left on it, another creature entering triggers nothing', () => {
    const ctx = pod('graftmage-empty');
    const graftmage = castGraftmage(ctx);
    graftmage.counters['+1/+1'] = 0;
    newcomerEnters(ctx, 'P1');
    // CR 603.4: the intervening-if is false as the creature enters.
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('vigean-graftmage-graft-creature-gone — if the entering creature leaves before resolution, no counter moves', () => {
    const ctx = pod('graftmage-gone');
    const graftmage = castGraftmage(ctx);
    const newcomer = newcomerEnters(ctx, 'P1');
    kill(ctx, newcomer);
    settle(ctx, yes);
    expect(onField(ctx, graftmage.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('vigean-graftmage-graft-last-counter-spent — two creatures entering with one counter left move only one counter, and the 0/0 Graftmage dies', () => {
    const ctx = pod('graftmage-last');
    const graftmage = castGraftmage(ctx);
    graftmage.counters['+1/+1'] = 1;
    const first = newcomerEnters(ctx, 'P1');
    const second = enterFrom(ctx, 'P1', LAB_CARD('Lab Second'), 'hand');
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    settle(ctx, yes);
    const moved =
      (onField(ctx, first.cardId)!.counters['+1/+1'] ?? 0) +
      (onField(ctx, second.cardId)!.counters['+1/+1'] ?? 0);
    expect(moved).toBe(1);
    // Its last counter gone, the 0/0 Graftmage dies to state-based actions.
    expect(onField(ctx, graftmage.cardId)).toBeUndefined();
  });

  it('vigean-graftmage-counter-replacements-apply — Hardened Scales adds one to the entry counters and to the moved counter', () => {
    const ctx = pod('graftmage-scales');
    spawn(ctx, 'P1', HARDENED_SCALES);
    const graftmage = castGraftmage(ctx);
    expect(graftmage.counters['+1/+1']).toBe(3);
    const newcomer = newcomerEnters(ctx, 'P1');
    settle(ctx, yes);
    // CR 122.5: moving a counter puts it on the creature, so the replacement applies.
    expect(onField(ctx, graftmage.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, newcomer.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('vigean-graftmage-untap-needs-a-counter — {1}{U} untaps a tapped creature with a +1/+1 counter, and one without is never offered', () => {
    const ctx = pod('graftmage-untap');
    const graftmage = castGraftmage(ctx);
    const bare = spawn(ctx, 'P1', LAB_CARD('Lab Bare'), { tapped: true });
    const marked = spawn(ctx, 'P1', LAB_CARD('Lab Marked'), { tapped: true });
    marked.counters['+1/+1'] = 1;
    addMana(playerById(ctx, 'P1'), [...generic(1), ...blue(1)]);
    const option = optionFor(ctx, 'P1', graftmage.id, /Untap/);
    expect(option).toBeDefined();
    const payload = option!.payload as PriorityActionPayload;
    const spec = interpretCard(card).activatedAbilities[0]!.ability.targets[0]!;
    const offered = computeTargetOptions(ctx, spec, 'P1').map(
      (id) => ctx.state.battlefield.find((perm) => perm.id === id)?.name,
    );
    expect(offered).toContain('Lab Marked');
    expect(offered).not.toContain('Lab Bare');
    takeAction(ctx, 'P1', payload, undefined, new Map([[0, marked.id]]));
    resolveTop(ctx);
    expect(onField(ctx, marked.cardId)!.tapped).toBe(false);
    expect(onField(ctx, bare.cardId)!.tapped).toBe(true);
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

const RESTORED: RestoredCard[] = [
  {
    name: 'Vigean Graftmage',
    sha256: 'dd42fa4af6fe68996fc19d54535d43d6ef28cc4915fe353b5d36a6451a592e9b',
    clauseCount: 2,
  },
  {
    name: 'Iron Apprentice',
    sha256: '46fcccb41b003c4e811243f737759ceade7e071cb7fc8852b48df71a94e0d680',
    clauseCount: 2,
  },
  {
    name: 'Sautekh Immortal',
    sha256: '26aff26dc163a5d13ad98195d74dcfd5d2260ab0cfad68928b3ac90c457ec21a',
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

describe('PR04 restoration gate', () => {
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
      expectModeled(entry.card);
    },
  );

  it('leaves no registration behind for cards the audit records as interpreter-restored', () => {
    const audit = JSON.parse(repoFile('docs/plans/card-catalog-audit.json')) as {
      interpreterRestored?: { oracleId: string; name: string; restoredIn: string }[];
    };
    const ours = (audit.interpreterRestored ?? []).filter(
      (entry) => entry.restoredIn === 'coverage-pr04',
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const entry of ours) {
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      expect(
        RESTORED.map((card) => card.name),
        entry.name,
      ).toContain(entry.name);
      expect(getOverride(fixtureOracleId(entry.name)), `${entry.name} alias`).toBeUndefined();
      expect(interpretCard(pinned(entry.name).card).modeled, entry.name).toBe(true);
    }
  });

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s declares implemented-unreviewed clauses mapped to engine and viewer evidence',
    (name, expected) => {
      const entry = pinned(name);
      const declared = manifest.cards[entry.card.oracleId];
      expect(declared?.name).toBe(name);
      expect(declared?.oracleSha256).toBe(expected.sha256);
      expect(declared?.implementationStatus).toBe('implemented-unreviewed');
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
