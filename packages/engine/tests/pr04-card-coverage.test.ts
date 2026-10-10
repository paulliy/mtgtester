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
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import type { Effect, TokenSpec } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { validateTriggerHead } from '../src/cards/trigger-contracts';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatAndExtraCombats, runTurn } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { createTokens, moveObject, playerById } from '../src/state/objects';
import { effectivePT } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  plains,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json', 'fixtures/coverage-pr04-oracle.json'];
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

/** Resolve `effects` as an ability of `perm`, then let any triggers they caused resolve. */
function resolveEffects(ctx: GameContext, perm: EnginePermanent, effects: Effect[]) {
  pump(
    executeAbility(
      ctx,
      {
        id: perm.id,
        cardId: perm.cardId,
        name: perm.name,
        oracleId: perm.oracleId,
        controllerId: perm.controllerId,
      },
      { kind: 'activated', targets: [], effects },
      [],
    ),
  );
  settle(ctx);
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
const white = (n: number) => Array.from({ length: n }, () => ({ symbol: 'W' as const }));
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
// PR04.20 Elite Scaleguard
// ---------------------------------------------------------------------------------------------

describe('Elite Scaleguard', () => {
  const { card } = pinned('Elite Scaleguard');
  const SMALL = oracle({
    name: 'Lab Small',
    typeLine: 'Creature — Secret',
    power: '1',
    toughness: '1',
  });
  const BIG = oracle({
    name: 'Lab Big',
    typeLine: 'Creature — Secret',
    power: '4',
    toughness: '4',
  });
  const TWIN_A = oracle({
    name: 'Lab Twin A',
    typeLine: 'Creature — Secret',
    power: '2',
    toughness: '2',
  });
  const TWIN_B = oracle({
    name: 'Lab Twin B',
    typeLine: 'Creature — Secret',
    power: '2',
    toughness: '2',
  });
  const GUARD = (name: string) =>
    oracle({ name, typeLine: 'Creature — Secret', power: '1', toughness: '4' });

  /** Cast it from hand and resolve it and its bolster, answering a tie with `pick`. */
  function castScaleguard(ctx: GameContext, pick?: string) {
    const object = castFromHand(ctx, 'P1', card, [...generic(4), ...white(1)]);
    resolveTop(ctx);
    const offered: string[] = [];
    settle(ctx, (decision) => {
      if (!/bolster/.test(decision.prompt)) return { index: 0, targets: new Map() };
      offered.push(...decision.options.map((option) => option.description));
      return optionMatching(decision, new RegExp(`^Bolster ${pick ?? ''}`));
    });
    return { scaleguard: onField(ctx, object.cardId)!, offered };
  }

  /**
   * Run combat with `attackers` (permanent id → defending player) attacking, nobody blocking.
   * Each trigger in turn targets the next creature named in `picks`; returns every name offered.
   */
  function attack(ctx: GameContext, attackers: Map<string, string>, picks: string[] = []) {
    const offered: string[][] = [];
    const nameOf = (id: string) => ctx.state.battlefield.find((perm) => perm.id === id)?.name;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => attackers.get(subjectId) ?? null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      if (decision.decisionType === 'chooseTargets') {
        const slot = decision.options[0]!.targets![0]!;
        offered.push(slot.options.map((id) => nameOf(id) ?? id));
        const pick = picks[offered.length - 1];
        const chosen = slot.options.find((id) => nameOf(id) === pick) ?? slot.options[0]!;
        return { index: 0, targets: new Map([[slot.slot, chosen]]) };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return offered;
  }

  it('elite-scaleguard-pinned-oracle-supported — the interpreter models bolster 2 and the defending-player tap trigger', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(def.triggers[0]!.targets).toEqual([]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'bolster', count: 2 }]);
    expect(def.triggers[1]!.trigger).toMatchObject({
      when: 'attacks',
      subject: { kind: 'permanent' },
      defendingPlayerIsEventPlayer: true,
    });
    expect(def.triggers[1]!.targets).toEqual([{ kind: 'creature', controller: 'eventPlayer' }]);
    expect(def.triggers[1]!.effects).toEqual([{ op: 'tapTarget', target: 0 }]);
  });

  it('elite-scaleguard-pinned-oracle-supported — "one or more creatures attack" has no single defending player, so it is not read', () => {
    const group = interpretCard(
      oracle({
        name: 'Lab Group Tapper',
        typeLine: 'Creature — Secret',
        oracleText:
          'Whenever one or more creatures you control attack, tap target creature defending player controls.',
      }),
    );
    expect(group.modeled).toBe(false);
    expect(JSON.stringify(group.triggers)).not.toContain('defendingPlayerIsEventPlayer');
  });

  it('elite-scaleguard-bolster-least-toughness — the counters go on the creature with the least toughness, without a choice', () => {
    const ctx = pod('scaleguard-least');
    const small = spawn(ctx, 'P1', SMALL);
    const big = spawn(ctx, 'P1', BIG);
    // An opponent's smaller creature is never a candidate: "creatures you control".
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Lab Tiny', typeLine: 'Creature — Secret', power: '0', toughness: '1' }),
    );
    const { scaleguard, offered } = castScaleguard(ctx);
    expect(offered).toEqual([]);
    expect(onField(ctx, small.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, big.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
    expect(scaleguard.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('elite-scaleguard-bolster-tie-is-a-choice — tied least toughness lets its controller choose, and it is not targeted', () => {
    const ctx = pod('scaleguard-tie');
    const a = spawn(ctx, 'P1', TWIN_A);
    const b = spawn(ctx, 'P1', TWIN_B);
    spawn(ctx, 'P1', BIG);
    const { offered } = castScaleguard(ctx, 'Lab Twin B');
    expect(offered).toEqual(['Bolster Lab Twin A', 'Bolster Lab Twin B']);
    expect(onField(ctx, b.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, a.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('elite-scaleguard-bolster-itself — alone, or the least tough itself, it bolsters itself', () => {
    const ctx = pod('scaleguard-self');
    spawn(ctx, 'P1', BIG);
    const { scaleguard } = castScaleguard(ctx);
    expect(scaleguard.counters['+1/+1']).toBe(2);
    expect(effectivePT(ctx, scaleguard)).toEqual({ power: 4, toughness: 5 });
  });

  it('elite-scaleguard-attack-taps-defenders-creature — a creature with a counter attacking P3 taps a creature P3 controls, never P2’s', () => {
    const ctx = pod('scaleguard-attack');
    spawn(ctx, 'P1', card);
    const attacker = spawn(ctx, 'P1', SMALL);
    attacker.counters['+1/+1'] = 1;
    const p2Guard = spawn(ctx, 'P2', GUARD('Lab P2 Guard'));
    const p3Guard = spawn(ctx, 'P3', GUARD('Lab P3 Guard'));
    const p3Other = spawn(ctx, 'P3', GUARD('Lab P3 Other'));
    const offered = attack(ctx, new Map([[attacker.id, 'P3']]), ['Lab P3 Guard']);
    expect(offered).toEqual([['Lab P3 Guard', 'Lab P3 Other']]);
    expect(onField(ctx, p3Guard.cardId)!.tapped).toBe(true);
    expect(onField(ctx, p3Other.cardId)!.tapped).toBe(false);
    expect(onField(ctx, p2Guard.cardId)!.tapped).toBe(false);
  });

  it('elite-scaleguard-attack-needs-a-counter — an attacker without a +1/+1 counter, or an opponent’s, triggers nothing', () => {
    const ctx = pod('scaleguard-no-counter');
    spawn(ctx, 'P1', card);
    const bare = spawn(ctx, 'P1', SMALL);
    const guard = spawn(ctx, 'P2', GUARD('Lab P2 Guard'));
    const offered = attack(ctx, new Map([[bare.id, 'P2']]));
    expect(offered).toEqual([]);
    expect(onField(ctx, guard.cardId)!.tapped).toBe(false);
  });

  it('elite-scaleguard-attack-each-attacker — two attackers with counters each trigger it, one tap per attacker', () => {
    const ctx = pod('scaleguard-two');
    spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', TWIN_A);
    const second = spawn(ctx, 'P1', TWIN_B);
    first.counters['+1/+1'] = 1;
    second.counters['+1/+1'] = 2;
    const one = spawn(ctx, 'P2', GUARD('Lab Guard One'));
    const two = spawn(ctx, 'P2', GUARD('Lab Guard Two'));
    const offered = attack(
      ctx,
      new Map([
        [first.id, 'P2'],
        [second.id, 'P2'],
      ]),
      ['Lab Guard One', 'Lab Guard Two'],
    );
    expect(offered).toHaveLength(2);
    expect(onField(ctx, one.cardId)!.tapped).toBe(true);
    expect(onField(ctx, two.cardId)!.tapped).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.12 Forgotten Ancient
// ---------------------------------------------------------------------------------------------

describe('Forgotten Ancient', () => {
  const { card } = pinned('Forgotten Ancient');
  const ALLY = LAB_CARD('Lab Ally');
  const RIVAL = LAB_CARD('Lab Rival');
  const RELIC = oracle({ name: 'Lab Relic', typeLine: 'Artifact', power: null, toughness: null });
  const HARDENED_SCALES = oracle({
    name: 'Hardened Scales',
    typeLine: 'Enchantment',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText:
      'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
  });

  /**
   * Run P1's whole turn. Each move prompt is answered with the next creature named in `moves`
   * ("stop" or running out declines). Returns every move prompt's option descriptions. The upkeep
   * trigger is not optional — moving none is the decline — so a "use this ability?" prompt fails.
   */
  function upkeep(ctx: GameContext, moves: string[]) {
    const seen: string[][] = [];
    const queue = [...moves];
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      if (/use this ability/.test(decision.prompt))
        throw new Error(`unexpected optional prompt: ${decision.prompt}`);
      if (/move a \+1\/\+1 counter onto another creature/.test(decision.prompt)) {
        seen.push(decision.options.map((option) => option.description));
        const next = queue.shift();
        return next === undefined || next === 'stop'
          ? optionMatching(decision, /^Move no more counters$/)
          : optionMatching(decision, new RegExp(`onto ${next} \\(`));
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return seen;
  }

  it('forgotten-ancient-pinned-oracle-supported — the interpreter models the cast counter and the upkeep division', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'castsSpell', caster: 'each' });
    expect(def.triggers[0]!.optional).toBe(true);
    expect(def.triggers[1]!.trigger).toEqual({ when: 'upkeep', player: 'you' });
    expect(def.triggers[1]!.optional).toBeFalsy();
    expect(def.triggers[1]!.effects).toEqual([
      {
        op: 'distributeCountersFromSource',
        counter: '+1/+1',
        selector: { kind: 'allOf', of: [{ kind: 'other' }, { kind: 'type', value: 'Creature' }] },
      },
    ]);
  });

  it('forgotten-ancient-any-player-casts — an opponent casting a spell lets you put a counter on it, or decline', () => {
    const ctx = pod('ancient-cast');
    const ancient = spawn(ctx, 'P1', card);
    const bolt = oracle({
      name: 'Lab Shock',
      typeLine: 'Instant',
      manaCost: '{R}',
      oracleText: 'Lab Shock deals 2 damage to any target.',
    });
    castFromHand(ctx, 'P2', bolt, [{ symbol: 'R' }], new Map([[0, 'P3']]));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P1']);
    settle(ctx, answers([[/use this ability/, /^Yes$/]]));
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1']).toBe(1);
    castFromHand(ctx, 'P2', bolt, [{ symbol: 'R' }], new Map([[0, 'P3']]));
    settle(ctx, answers([[/use this ability/, /^No$/]]));
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('forgotten-ancient-upkeep-divides — three counters are divided two to your creature and one to an opponent’s', () => {
    const ctx = pod('ancient-divide');
    const ancient = spawn(ctx, 'P1', card);
    ancient.counters['+1/+1'] = 3;
    const ally = spawn(ctx, 'P1', ALLY);
    const rival = spawn(ctx, 'P2', RIVAL);
    const seen = upkeep(ctx, ['Lab Ally', 'Lab Ally', 'Lab Rival']);
    // Three counters, three picks, then nothing is left to move.
    expect(seen).toHaveLength(3);
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
    expect(onField(ctx, ally.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, rival.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('forgotten-ancient-may-move-none — stopping at once moves nothing, and stopping early keeps the rest', () => {
    const ctx = pod('ancient-none');
    const ancient = spawn(ctx, 'P1', card);
    ancient.counters['+1/+1'] = 2;
    const ally = spawn(ctx, 'P1', ALLY);
    upkeep(ctx, ['stop']);
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1']).toBe(2);
    expect(onField(ctx, ally.cardId)!.counters['+1/+1'] ?? 0).toBe(0);

    const later = pod('ancient-early');
    const keeper = spawn(later, 'P1', card);
    keeper.counters['+1/+1'] = 2;
    const friend = spawn(later, 'P1', ALLY);
    upkeep(later, ['Lab Ally', 'stop']);
    expect(onField(later, keeper.cardId)!.counters['+1/+1']).toBe(1);
    expect(onField(later, friend.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('forgotten-ancient-may-move-none — with no counters, the upkeep asks nothing at all', () => {
    const ctx = pod('ancient-empty');
    const ancient = spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', ALLY);
    const prompts: string[] = [];
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass < 0) prompts.push(decision.prompt);
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(prompts).toEqual([]);
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('forgotten-ancient-other-creatures-only — only other creatures are offered, never itself or a noncreature', () => {
    const ctx = pod('ancient-offered');
    const ancient = spawn(ctx, 'P1', card);
    ancient.counters['+1/+1'] = 1;
    spawn(ctx, 'P1', ALLY);
    spawn(ctx, 'P1', RELIC);
    const seen = upkeep(ctx, ['stop']);
    expect(seen).toEqual([['Move a +1/+1 counter onto Lab Ally (1)', 'Move no more counters']]);
  });

  it('forgotten-ancient-moves-together — under Hardened Scales two counters moved onto one creature become three, not four', () => {
    const ctx = pod('ancient-scales');
    spawn(ctx, 'P1', HARDENED_SCALES);
    const ancient = spawn(ctx, 'P1', card);
    ancient.counters['+1/+1'] = 2;
    const ally = spawn(ctx, 'P1', ALLY);
    upkeep(ctx, ['Lab Ally', 'Lab Ally']);
    // CR 122.5: the moved counters are put on it in one event, so the replacement applies once.
    expect(onField(ctx, ally.cardId)!.counters['+1/+1']).toBe(3);
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('forgotten-ancient-your-upkeep-only — another player’s upkeep does not trigger it', () => {
    const ctx = pod('ancient-their-turn');
    const ancient = spawn(ctx, 'P1', card);
    ancient.counters['+1/+1'] = 2;
    spawn(ctx, 'P1', ALLY);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(upkeep(ctx, ['Lab Ally'])).toEqual([]);
    expect(onField(ctx, ancient.cardId)!.counters['+1/+1']).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Primitive: counters being put on a permanent (CR 122.6)
// ---------------------------------------------------------------------------------------------

describe('Primitive: counters-put trigger', () => {
  const GROWER = oracle({
    name: 'Lab Grower',
    typeLine: 'Creature — Secret',
    manaCost: '{G}',
    power: '0',
    toughness: '1',
    oracleText:
      'This creature enters with two +1/+1 counters on it.\nWhenever one or more +1/+1 counters are put on this creature, draw a card.',
  });

  it('counters-put-primitive-entering-counts — entering with counters is counters being put on it, and fires once', () => {
    const ctx = pod('counters-put-entry');
    const before = playerById(ctx, 'P1').hand.length;
    const grower = enterFrom(ctx, 'P1', GROWER, 'hand');
    expect(grower.counters['+1/+1']).toBe(2);
    settle(ctx);
    expect(playerById(ctx, 'P1').hand.length).toBe(before + 1);
  });

  it('counters-put-primitive-kind — a -1/-1 counter is not a +1/+1 counter, and one placement of three fires once', () => {
    const ctx = pod('counters-put-kind');
    const grower = enterFrom(ctx, 'P1', GROWER, 'hand');
    settle(ctx);
    const before = playerById(ctx, 'P1').hand.length;
    resolveEffects(ctx, grower, [
      { op: 'putCounters', target: 'source', counter: '-1/-1', count: 1 },
    ]);
    expect(playerById(ctx, 'P1').hand.length).toBe(before);
    resolveEffects(ctx, grower, [
      { op: 'putCounters', target: 'source', counter: '+1/+1', count: 3 },
    ]);
    expect(playerById(ctx, 'P1').hand.length).toBe(before + 1);
  });

  it('counters-put-primitive-contract — a counter kind is valid only on a countersPut head', () => {
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'enters', subject: { kind: 'self' }, counter: '+1/+1' },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.message)).toContain(
      'a counter kind requires a countersPut event',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.03 Pensive Professor
// ---------------------------------------------------------------------------------------------

describe('Pensive Professor', () => {
  const { card } = pinned('Pensive Professor');
  /** An instant costing `cost`, so it can be cast at any time and leaves no permanent. */
  const instant = (name: string, cost: string) =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost: cost,
      power: null,
      toughness: null,
      oracleText: 'You gain 1 life.',
    });
  const ZERO = instant('Lab Zero', '{0}');
  const ONE = instant('Lab One', '{1}');
  const TWO = instant('Lab Two', '{2}');

  function hand(ctx: GameContext) {
    return playerById(ctx, 'P1').hand.length;
  }

  it('pensive-professor-pinned-oracle-supported — the interpreter alone models Increment and the counters-put draw', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'castsSpell',
      caster: 'you',
      condition: { kind: 'anyOf' },
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'putCountersEach', selector: { kind: 'self' }, counter: '+1/+1', count: 1 },
    ]);
    expect(def.triggers[1]!.trigger).toEqual({
      when: 'countersPut',
      subject: { kind: 'self' },
      counter: '+1/+1',
    });
  });

  it('pensive-professor-increment-grows-and-draws — a one-mana spell beats its 0 power, so it gets a counter and you draw', () => {
    const ctx = pod('professor-grows');
    const professor = spawn(ctx, 'P1', card);
    const before = hand(ctx);
    castFromHand(ctx, 'P1', ONE, generic(1));
    settle(ctx);
    expect(onField(ctx, professor.cardId)!.counters['+1/+1']).toBe(1);
    // Lab One was conjured into the hand and cast from it; the counter drew one card.
    expect(hand(ctx)).toBe(before + 1);
  });

  it('pensive-professor-increment-threshold — as a 1/3, one mana is not greater than 1 or 3, but two mana is greater than 1', () => {
    const ctx = pod('professor-threshold');
    const professor = spawn(ctx, 'P1', card);
    professor.counters['+1/+1'] = 1;
    castFromHand(ctx, 'P1', ONE, generic(1));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    castFromHand(ctx, 'P1', TWO, generic(2));
    settle(ctx);
    expect(onField(ctx, professor.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('pensive-professor-increment-no-mana — a spell cast for no mana adds nothing', () => {
    const ctx = pod('professor-free');
    const professor = spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', ZERO, []);
    settle(ctx);
    expect(onField(ctx, professor.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('pensive-professor-increment-your-spells — an opponent’s spell does not trigger Increment', () => {
    const ctx = pod('professor-opponent');
    const professor = spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P2', TWO, generic(2));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(onField(ctx, professor.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('pensive-professor-increment-rechecked — grown in response, the one-mana spell no longer beats it on resolution (CR 603.4)', () => {
    const ctx = pod('professor-recheck');
    const professor = spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', ONE, generic(1));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    professor.counters['+1/+1'] = 1;
    settle(ctx);
    expect(onField(ctx, professor.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('pensive-professor-counters-draw-once — three +1/+1 counters put at once draw one card; a -1/-1 counter draws none', () => {
    const ctx = pod('professor-counters');
    const professor = spawn(ctx, 'P1', card);
    const before = hand(ctx);
    resolveEffects(ctx, professor, [
      { op: 'putCounters', target: 'source', counter: '+1/+1', count: 3 },
    ]);
    expect(hand(ctx)).toBe(before + 1);
    resolveEffects(ctx, professor, [
      { op: 'putCounters', target: 'source', counter: '-1/-1', count: 1 },
    ]);
    expect(hand(ctx)).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.15 Mikey & Leo, Chaos & Order
// ---------------------------------------------------------------------------------------------

describe('Mikey & Leo, Chaos & Order', () => {
  const { card } = pinned('Mikey & Leo, Chaos & Order');
  const ALLY = LAB_CARD('Lab Ally');
  const RIVAL = LAB_CARD('Lab Rival');
  const ARRIVAL = oracle({
    name: 'Lab Arrival',
    typeLine: 'Creature — Secret',
    manaCost: '{G}',
    power: '0',
    toughness: '1',
    oracleText: 'This creature enters with a +1/+1 counter on it.',
  });

  /** `from`'s controller puts `count` `counter` counters on `target` with an effect of `from`. */
  function putCounter(
    ctx: GameContext,
    from: EnginePermanent,
    target: EnginePermanent,
    counter = '+1/+1',
  ) {
    pump(
      executeAbility(
        ctx,
        {
          id: from.id,
          cardId: from.cardId,
          name: from.name,
          oracleId: from.oracleId,
          controllerId: from.controllerId,
        },
        {
          kind: 'activated',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'putCounters', target: 0, counter, count: 1 }],
        },
        [target.id],
      ),
    );
    settle(ctx);
  }

  const hand = (ctx: GameContext) => playerById(ctx, 'P1').hand.length;

  it('mikey-and-leo-pinned-oracle-supported — the interpreter models a you-put counters trigger limited to once each turn', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'countersPut',
      subject: { kind: 'permanent' },
      byYou: true,
      oncePerTurn: true,
    });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('mikey-and-leo-you-put-a-counter-draws — your effect putting a counter on your creature draws a card', () => {
    const ctx = pod('mikey-draws');
    const mikey = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', ALLY);
    const before = hand(ctx);
    putCounter(ctx, mikey, ally);
    expect(hand(ctx)).toBe(before + 1);
  });

  it('mikey-and-leo-once-each-turn — a second counter that turn draws nothing; the next turn it draws again', () => {
    const ctx = pod('mikey-once');
    const mikey = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', ALLY);
    const before = hand(ctx);
    putCounter(ctx, mikey, ally);
    putCounter(ctx, mikey, mikey);
    expect(hand(ctx)).toBe(before + 1);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    quietTurn(ctx);
    const next = hand(ctx);
    putCounter(ctx, mikey, ally);
    expect(hand(ctx)).toBe(next + 1);
  });

  it('mikey-and-leo-any-counter-kind — a -1/-1 counter you put on your creature counts too', () => {
    const ctx = pod('mikey-kind');
    const mikey = spawn(ctx, 'P1', card);
    const ally = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lab Sturdy', typeLine: 'Creature — Secret', power: '2', toughness: '3' }),
    );
    const before = hand(ctx);
    putCounter(ctx, mikey, ally, '-1/-1');
    expect(hand(ctx)).toBe(before + 1);
  });

  it('mikey-and-leo-entering-with-counters — your creature entering with a counter is a counter you put on it (CR 122.6a)', () => {
    const ctx = pod('mikey-entry');
    spawn(ctx, 'P1', card);
    const before = hand(ctx);
    enterFrom(ctx, 'P1', ARRIVAL, 'hand');
    settle(ctx);
    expect(hand(ctx)).toBe(before + 1);
  });

  it('mikey-and-leo-not-theirs — an opponent putting a counter on your creature, or you on theirs, draws nothing', () => {
    const ctx = pod('mikey-not-theirs');
    const mikey = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', ALLY);
    const rival = spawn(ctx, 'P2', RIVAL);
    const before = hand(ctx);
    putCounter(ctx, rival, ally);
    putCounter(ctx, mikey, rival);
    expect(hand(ctx)).toBe(before);
    // Neither used up the once-each-turn trigger.
    putCounter(ctx, mikey, ally);
    expect(hand(ctx)).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.19 Bess, Soul Nourisher
// ---------------------------------------------------------------------------------------------

describe('Bess, Soul Nourisher', () => {
  const { card } = pinned('Bess, Soul Nourisher');
  const CITIZEN: TokenSpec = {
    name: 'Citizen',
    typeLine: 'Token Creature — Human Citizen',
    types: ['Creature'],
    subtypes: ['Human', 'Citizen'],
    colors: ['G', 'W'],
    power: 1,
    toughness: 1,
  };
  const ONE_ONE = (name: string) =>
    oracle({ name, typeLine: 'Creature — Secret', power: '1', toughness: '1' });
  const TWO_TWO = oracle({
    name: 'Lab Two-Two',
    typeLine: 'Creature — Secret',
    power: '2',
    toughness: '2',
  });
  const GROWN = oracle({
    name: 'Lab Grown',
    typeLine: 'Creature — Secret',
    manaCost: '{G}',
    power: '1',
    toughness: '1',
    oracleText: 'This creature enters with a +1/+1 counter on it.',
  });

  /** Run combat with only Bess attacking P2, nobody blocking. */
  function bessAttacks(ctx: GameContext, bess: EnginePermanent) {
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) => (subjectId === bess.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  it('bess-soul-nourisher-pinned-oracle-supported — the interpreter models the batched base-1/1 enters counter and the attack pump', () => {
    expect(getOverride(card.oracleId)).toBeUndefined();
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toMatchObject({ when: 'enters', aggregate: true });
    expect(JSON.stringify(def.triggers[0]!.trigger)).toContain('"basePowerToughness"');
    expect(def.triggers[1]!.trigger).toEqual({ when: 'attacks', subject: { kind: 'self' } });
    expect(def.triggers[1]!.effects).toMatchObject([
      {
        op: 'pumpEachUntilEot',
        power: { kind: 'countersOnSelf', counter: '+1/+1' },
        toughness: { kind: 'countersOnSelf', counter: '+1/+1' },
      },
    ]);
  });

  it('bess-soul-nourisher-one-counter-per-batch — three 1/1 tokens entering together give one counter', () => {
    const ctx = pod('bess-batch');
    const bess = spawn(ctx, 'P1', card);
    createTokens(ctx, CITIZEN, 3, 'P1');
    settle(ctx);
    expect(onField(ctx, bess.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('bess-soul-nourisher-base-not-current — a base-1/1 entering with a counter counts; a 2/2 or an opponent’s 1/1 does not', () => {
    const ctx = pod('bess-base');
    const bess = spawn(ctx, 'P1', card);
    const grown = enterFrom(ctx, 'P1', GROWN, 'hand');
    expect(effectivePT(ctx, grown)).toEqual({ power: 2, toughness: 2 });
    settle(ctx);
    expect(onField(ctx, bess.cardId)!.counters['+1/+1']).toBe(1);
    enterFrom(ctx, 'P1', TWO_TWO, 'hand');
    enterFrom(ctx, 'P2', ONE_ONE('Lab Rival'), 'hand');
    settle(ctx);
    expect(onField(ctx, bess.cardId)!.counters['+1/+1']).toBe(1);
  });

  it('bess-soul-nourisher-not-itself — Bess, a 1/1, entering does not count itself', () => {
    const ctx = pod('bess-self');
    const bess = enterFrom(ctx, 'P1', card, 'hand');
    settle(ctx);
    expect(onField(ctx, bess.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('bess-soul-nourisher-attack-pump — with three counters, other base-1/1 creatures get +3/+3 until end of turn, locked as it resolves', () => {
    const ctx = pod('bess-attack');
    const bess = spawn(ctx, 'P1', card);
    bess.counters['+1/+1'] = 3;
    const small = spawn(ctx, 'P1', ONE_ONE('Lab Small'));
    const grown = spawn(ctx, 'P1', ONE_ONE('Lab Countered'));
    grown.counters['+1/+1'] = 1;
    const big = spawn(ctx, 'P1', TWO_TWO);
    const rival = spawn(ctx, 'P2', ONE_ONE('Lab Rival'));
    bessAttacks(ctx, bess);
    expect(effectivePT(ctx, onField(ctx, small.cardId)!)).toEqual({ power: 4, toughness: 4 });
    expect(effectivePT(ctx, onField(ctx, grown.cardId)!)).toEqual({ power: 5, toughness: 5 });
    expect(effectivePT(ctx, onField(ctx, big.cardId)!)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, onField(ctx, rival.cardId)!)).toEqual({ power: 1, toughness: 1 });
    // Bess itself is not "other": it is a 1/1 with three counters.
    expect(effectivePT(ctx, onField(ctx, bess.cardId)!)).toEqual({ power: 4, toughness: 4 });
    // X was fixed on resolution: losing the counters afterwards changes nothing.
    onField(ctx, bess.cardId)!.counters['+1/+1'] = 0;
    expect(effectivePT(ctx, onField(ctx, small.cardId)!)).toEqual({ power: 4, toughness: 4 });
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.05 Aetheric Amplifier
// ---------------------------------------------------------------------------------------------

describe('Aetheric Amplifier', () => {
  const { card } = pinned('Aetheric Amplifier');

  /** The Amplifier's activations offered to P1 now, one per mode (CR 700.2a). */
  function activations(ctx: GameContext, amplifierId: string) {
    return priorityOptions(ctx, 'P1').filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === amplifierId;
    });
  }

  function board(seed: string) {
    const ctx = pod(seed);
    const amplifier = spawn(ctx, 'P1', card);
    addMana(playerById(ctx, 'P1'), generic(4));
    return { ctx, amplifier };
  }

  it('aetheric-amplifier-pinned-oracle-supported — one modal sorcery-speed activation, plus the mana ability', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.activatedAbilities).toHaveLength(1);
    const [ability] = def.activatedAbilities;
    expect(ability!.timing).toBe('sorcery');
    expect(ability!.costs.map((cost) => cost.kind)).toEqual(['mana', 'tap']);
    expect(ability!.ability.modes).toMatchObject({ minChoices: 1, maxChoices: 1 });
    expect(ability!.ability.modes!.options.map((option) => option.effects)).toEqual([
      [{ op: 'doubleCountersTarget', target: 0 }],
      [{ op: 'doublePlayerCounters' }],
    ]);
    expect(ability!.ability.modes!.options.map((option) => option.targetSlots)).toEqual([[0], []]);
  });

  it('aetheric-amplifier-one-activation-per-mode — only the permanent mode carries a target', () => {
    const { ctx, amplifier } = board('amplifier-modes');
    const offered = activations(ctx, amplifier.id);
    expect(offered.map((option) => option.data?.['modeLabel'])).toEqual([
      'double the number of each kind of counter on target permanent',
      'double the number of each kind of counter you have',
    ]);
    expect(offered.map((option) => option.targets?.length ?? 0)).toEqual([1, 0]);
  });

  it('aetheric-amplifier-doubles-permanent-counters — each kind on the target doubles, others are untouched', () => {
    const { ctx, amplifier } = board('amplifier-permanent');
    const target = spawn(ctx, 'P2', LAB_CARD('Lab Target'));
    target.counters['+1/+1'] = 2;
    target.counters['charge'] = 3;
    const bystander = spawn(ctx, 'P2', LAB_CARD('Lab Bystander'));
    bystander.counters['+1/+1'] = 1;
    const option = activations(ctx, amplifier.id).find((o) => o.targets?.length === 1)!;
    takeAction(
      ctx,
      'P1',
      option.payload as PriorityActionPayload,
      undefined,
      new Map([[option.targets![0]!.slot, target.id]]),
    );
    expect(amplifier.tapped).toBe(true);
    resolveTop(ctx);
    expect(target.counters['+1/+1']).toBe(4);
    expect(target.counters['charge']).toBe(6);
    expect(bystander.counters['+1/+1']).toBe(1);
  });

  it('aetheric-amplifier-doubles-your-counters — your energy and poison double, an opponent’s do not', () => {
    const { ctx, amplifier } = board('amplifier-player');
    const me = playerById(ctx, 'P1');
    const them = playerById(ctx, 'P2');
    me.energy = 3;
    me.poisonCounters = 2;
    them.energy = 5;
    them.poisonCounters = 1;
    const option = activations(ctx, amplifier.id).find((o) => (o.targets?.length ?? 0) === 0)!;
    takeAction(ctx, 'P1', option.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(me.energy).toBe(6);
    expect(me.poisonCounters).toBe(4);
    expect(them.energy).toBe(5);
    expect(them.poisonCounters).toBe(1);
  });

  it('aetheric-amplifier-sorcery-speed — not offered with a spell on the stack, on another turn, or tapped', () => {
    const { ctx, amplifier } = board('amplifier-timing');
    expect(activations(ctx, amplifier.id)).toHaveLength(2);

    const quick = oracle({
      name: 'Lab Quick',
      typeLine: 'Instant',
      manaCost: '{0}',
      power: null,
      toughness: null,
      oracleText: 'You gain 1 life.',
    });
    castFromHand(ctx, 'P1', quick, []);
    expect(ctx.state.stack).toHaveLength(1);
    expect(activations(ctx, amplifier.id)).toHaveLength(0);
    resolveTop(ctx);
    expect(activations(ctx, amplifier.id)).toHaveLength(2);

    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(activations(ctx, amplifier.id)).toHaveLength(0);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;

    amplifier.tapped = true;
    expect(activations(ctx, amplifier.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// G3 reflexive triggers: shared helpers
// ---------------------------------------------------------------------------------------------

/** "Can't be blocked this turn" effects that name `perm`. */
function unblockable(ctx: GameContext, perm: EnginePermanent): boolean {
  return ctx.state.effects.some(
    (effect) => effect.kind === 'cantBeBlocked' && effect.targetCardIds.includes(perm.cardId),
  );
}

/**
 * Run combat with `attackers` attacking P2 and nobody blocking. `pay` answers a "may pay" prompt;
 * each count-target prompt picks the next name in `picks` ("stop" or running out stops). Returns
 * every prompt seen and the names offered at each count-target prompt.
 */
function reflexiveCombat(
  ctx: GameContext,
  attackers: string[],
  pay: boolean,
  picks: string[] = [],
) {
  const prompts: string[] = [];
  const offered: string[][] = [];
  const queue = [...picks];
  pump(runCombatAndExtraCombats(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, (subjectId) => (attackers.includes(subjectId) ? 'P2' : null));
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    prompts.push(decision.prompt);
    if (/Pay it\?/.test(decision.prompt))
      return optionMatching(decision, pay ? /^Pay / : /^Don't pay$/);
    if (/choose (a|another) target/.test(decision.prompt)) {
      offered.push(
        decision.options
          .filter((option) => option.type === 'pickTarget')
          .map((option) => option.description),
      );
      const next = queue.shift();
      return next === undefined || next === 'stop'
        ? optionMatching(decision, /^Choose no more targets$/)
        : optionMatching(decision, new RegExp(`^Target ${next}\\b`));
    }
    return { index: 0, targets: new Map() };
  });
  return { prompts, offered };
}

// ---------------------------------------------------------------------------------------------
// PR04.17 The Thing
// ---------------------------------------------------------------------------------------------

describe('The Thing', () => {
  const { card } = pinned('The Thing');
  const RELIC = oracle({
    name: 'Lab Relic',
    typeLine: 'Artifact',
    manaCost: '{1}',
    power: null,
    toughness: null,
  });

  /** The Thing plus one each of the four basic lands its payment needs. */
  function board(seed: string) {
    const ctx = pod(seed);
    const thing = spawn(ctx, 'P1', card);
    for (const land of [mountain(), forest(), plains(), island()]) spawn(ctx, 'P1', land);
    return { ctx, thing };
  }

  it('the-thing-pinned-oracle-supported — the combat counters and the paid reflexive double are modeled', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('trample');
    expect(def.triggers).toHaveLength(2);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'beginningOfCombat',
      player: 'you',
      condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'putCountersEach', selector: { kind: 'self' }, counter: '+1/+1', count: 4 },
    ]);
    expect(def.triggers[1]!.trigger).toEqual({ when: 'attacks', subject: { kind: 'self' } });
    expect(def.triggers[1]!.optional).toBe(false);
    expect(def.triggers[1]!.targets).toEqual([]);
    const [reflexive] = def.triggers[1]!.effects;
    expect(reflexive).toMatchObject({
      op: 'mayPayManaThenReflexive',
      then: {
        targets: [{ kind: 'permanent', controller: 'you', count: { min: 0, max: Infinity } }],
        effects: [{ op: 'doubleCountersEachChosen', targetSlot: 0 }],
      },
    });
  });

  it('the-thing-pinned-oracle-supported — a "when you do" followed by another sentence stays unmodeled rather than guessing which ability owns it', () => {
    const def = interpretCard(
      oracle({
        name: 'Lab Two Sentences',
        typeLine: 'Creature — Secret',
        oracleText:
          'Whenever this creature attacks, you may pay {1}. When you do, this creature deals 1 damage to target creature. Scry 2.',
      }),
    );
    expect(def.modeled).toBe(false);
  });

  it('the-thing-combat-counters — four counters at your beginning of combat only after a noncreature spell', () => {
    const quiet = pod('thing-no-spell');
    const idle = spawn(quiet, 'P1', card);
    reflexiveCombat(quiet, [], false);
    expect(onField(quiet, idle.cardId)!.counters['+1/+1'] ?? 0).toBe(0);

    const ctx = pod('thing-spell');
    const thing = spawn(ctx, 'P1', card);
    playerById(ctx, 'P1').noncreatureSpellsCastThisTurn = 1;
    reflexiveCombat(ctx, [], false);
    expect(onField(ctx, thing.cardId)!.counters['+1/+1']).toBe(4);
  });

  it('the-thing-pay-then-double — paying fires the reflexive trigger, which doubles every kind on each chosen permanent', () => {
    const { ctx, thing } = board('thing-pay');
    thing.counters['+1/+1'] = 2;
    const relic = spawn(ctx, 'P1', RELIC);
    relic.counters['charge'] = 3;
    relic.counters['+1/+1'] = 1;
    const skipped = spawn(ctx, 'P1', LAB_CARD('Lab Skipped'));
    skipped.counters['+1/+1'] = 1;
    const rival = spawn(ctx, 'P2', LAB_CARD('Lab Rival'));
    rival.counters['+1/+1'] = 1;
    const { prompts, offered } = reflexiveCombat(ctx, [thing.id], true, ['The Thing', 'Lab Relic']);
    // The pay choice comes first; the targets are announced only by the reflexive trigger.
    expect(prompts.findIndex((p) => /Pay it\?/.test(p))).toBeLessThan(
      prompts.findIndex((p) => /choose a target/.test(p)),
    );
    // "Permanents you control": the opponent's creature is never offered.
    expect(offered.flat().some((name) => name.includes('Lab Rival'))).toBe(false);
    expect(onField(ctx, thing.cardId)!.counters['+1/+1']).toBe(4);
    expect(relic.counters['charge']).toBe(6);
    expect(relic.counters['+1/+1']).toBe(2);
    expect(skipped.counters['+1/+1']).toBe(1);
    expect(rival.counters['+1/+1']).toBe(1);
    // The four basic lands paid {R}{G}{W}{U}.
    expect(ctx.state.battlefield.filter((p) => p.tapped && p.name !== 'The Thing')).toHaveLength(4);
  });

  it('the-thing-decline-no-trigger — declining to pay fires nothing and asks for no targets', () => {
    const { ctx, thing } = board('thing-decline');
    thing.counters['+1/+1'] = 2;
    const { prompts } = reflexiveCombat(ctx, [thing.id], false, ['The Thing']);
    expect(prompts.some((p) => /choose a target/.test(p))).toBe(false);
    expect(onField(ctx, thing.cardId)!.counters['+1/+1']).toBe(2);
  });

  it('the-thing-cannot-pay — without the four colors there is no payment prompt and no trigger', () => {
    const ctx = pod('thing-broke');
    const thing = spawn(ctx, 'P1', card);
    thing.counters['+1/+1'] = 2;
    for (const land of [mountain(), forest(), plains()]) spawn(ctx, 'P1', land);
    const { prompts } = reflexiveCombat(ctx, [thing.id], true, ['The Thing']);
    expect(prompts).toEqual([]);
    expect(onField(ctx, thing.cardId)!.counters['+1/+1']).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.14 Lockjaw, Slobbering Teleporter
// ---------------------------------------------------------------------------------------------

describe('Lockjaw, Slobbering Teleporter', () => {
  const { card } = pinned('Lockjaw, Slobbering Teleporter');

  it('lockjaw-pinned-oracle-supported — the counter and the reflexive unblockability are modeled', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('vigilance');
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'beginningOfCombat',
      player: 'you',
      condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
    });
    expect(def.triggers[0]!.targets).toEqual([]);
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'putCountersOnSourceThenReflexive',
        counter: '+1/+1',
        count: 1,
        then: {
          targets: [
            {
              kind: 'creature',
              controller: 'you',
              filter: { kind: 'other' },
              count: { min: 0, max: 1 },
            },
          ],
          effects: [
            { op: 'cantBeBlockedUntilEot', target: 'source' },
            { op: 'cantBeBlockedEachChosen', targetSlot: 0 },
          ],
        },
      },
    ]);
  });

  it('lockjaw-counter-then-unblockable — after a noncreature spell it grows, then it and one other creature you control can’t be blocked', () => {
    const ctx = pod('lockjaw-go');
    const lockjaw = spawn(ctx, 'P1', card);
    const friend = spawn(ctx, 'P1', LAB_CARD('Lab Friend'));
    const left = spawn(ctx, 'P1', LAB_CARD('Lab Left'));
    const rival = spawn(ctx, 'P2', LAB_CARD('Lab Rival'));
    playerById(ctx, 'P1').noncreatureSpellsCastThisTurn = 1;
    const { offered } = reflexiveCombat(ctx, [], false, ['Lab Friend']);
    expect(onField(ctx, lockjaw.cardId)!.counters['+1/+1']).toBe(1);
    // "Other target creature you control": neither Lockjaw nor the opponent's creature.
    expect(offered).toHaveLength(1);
    expect(offered[0]!.some((name) => /Lockjaw|Lab Rival/.test(name))).toBe(false);
    expect(unblockable(ctx, onField(ctx, lockjaw.cardId)!)).toBe(true);
    expect(unblockable(ctx, friend)).toBe(true);
    expect(unblockable(ctx, left)).toBe(false);
    expect(unblockable(ctx, rival)).toBe(false);
  });

  it('lockjaw-up-to-one — choosing no other creature still makes Lockjaw unblockable', () => {
    const ctx = pod('lockjaw-alone');
    const lockjaw = spawn(ctx, 'P1', card);
    const friend = spawn(ctx, 'P1', LAB_CARD('Lab Friend'));
    playerById(ctx, 'P1').noncreatureSpellsCastThisTurn = 1;
    reflexiveCombat(ctx, [], false, ['stop']);
    expect(unblockable(ctx, onField(ctx, lockjaw.cardId)!)).toBe(true);
    expect(unblockable(ctx, friend)).toBe(false);
  });

  it('lockjaw-needs-noncreature-spell — without one there is no counter and no reflexive trigger', () => {
    const ctx = pod('lockjaw-quiet');
    const lockjaw = spawn(ctx, 'P1', card);
    playerById(ctx, 'P1').spellsCastThisTurn = 1;
    reflexiveCombat(ctx, [], false);
    expect(onField(ctx, lockjaw.cardId)!.counters['+1/+1'] ?? 0).toBe(0);
    expect(unblockable(ctx, onField(ctx, lockjaw.cardId)!)).toBe(false);
  });

  it('lockjaw-no-counter-no-trigger — if Lockjaw is gone when the trigger resolves, no counter is put and “when you do” never triggers', () => {
    const ctx = pod('lockjaw-gone');
    const lockjaw = spawn(ctx, 'P1', card);
    const effects = interpretCard(card).triggers[0]!.effects;
    kill(ctx, lockjaw);
    resolveEffects(ctx, lockjaw, effects);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.effects.some((effect) => effect.kind === 'cantBeBlocked')).toBe(false);

    // The same effects with Lockjaw still there do trigger it.
    const live = pod('lockjaw-here');
    const here = spawn(live, 'P1', card);
    resolveEffects(live, here, effects);
    expect(here.counters['+1/+1']).toBe(1);
    expect(unblockable(live, here)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.06 Belladonna Took
// ---------------------------------------------------------------------------------------------

describe('Belladonna Took', () => {
  const { card } = pinned('Belladonna Took');
  const FOOD: TokenSpec = {
    name: 'Lab Token',
    typeLine: 'Token Artifact — Clue',
    types: ['Artifact'],
    subtypes: ['Clue'],
    colors: [],
    power: null,
    toughness: null,
  };

  /** Create one token for `playerId` and let every trigger resolve. */
  function token(ctx: GameContext, playerId = 'P1') {
    createTokens(ctx, FOOD, 1, playerId);
    settle(ctx);
  }

  function snapshot(ctx: GameContext, belladonna: EnginePermanent) {
    const me = playerById(ctx, 'P1');
    return {
      life: me.life,
      hand: me.hand.length,
      counters: onField(ctx, belladonna.cardId)?.counters['+1/+1'] ?? 0,
    };
  }

  it('belladonna-took-pinned-oracle-supported — one token trigger whose first, second and third resolutions differ', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'enters',
      subject: { kind: 'permanent' },
    });
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'byResolutionCountThisTurn',
        cases: [
          { n: 1, effects: [{ op: 'gainLife' }] },
          { n: 2, effects: [{ op: 'draw' }] },
          { n: 3, effects: [{ op: 'putCountersEach', counter: '+1/+1', count: 1 }] },
        ],
        otherwise: [],
      },
    ]);
  });

  it('belladonna-took-first-second-third — life, then a card, then a counter on each creature you control, then nothing', () => {
    const ctx = pod('belladonna-sequence');
    const belladonna = spawn(ctx, 'P1', card);
    const ally = spawn(ctx, 'P1', LAB_CARD('Lab Ally'));
    const rival = spawn(ctx, 'P2', LAB_CARD('Lab Rival'));
    const start = snapshot(ctx, belladonna);
    token(ctx);
    expect(snapshot(ctx, belladonna)).toEqual({ ...start, life: start.life + 1 });
    token(ctx);
    expect(snapshot(ctx, belladonna)).toEqual({
      ...start,
      life: start.life + 1,
      hand: start.hand + 1,
    });
    token(ctx);
    expect(snapshot(ctx, belladonna)).toEqual({
      life: start.life + 1,
      hand: start.hand + 1,
      counters: 1,
    });
    expect(ally.counters['+1/+1']).toBe(1);
    expect(rival.counters['+1/+1'] ?? 0).toBe(0);
    // A fourth resolution matches no case.
    token(ctx);
    expect(snapshot(ctx, belladonna)).toEqual({
      life: start.life + 1,
      hand: start.hand + 1,
      counters: 1,
    });
  });

  it('belladonna-took-your-tokens-only — an opponent’s token does not trigger it or use up the first resolution', () => {
    const ctx = pod('belladonna-theirs');
    const belladonna = spawn(ctx, 'P1', card);
    const start = snapshot(ctx, belladonna);
    token(ctx, 'P2');
    expect(snapshot(ctx, belladonna)).toEqual(start);
    token(ctx);
    expect(snapshot(ctx, belladonna).life).toBe(start.life + 1);
  });

  it('belladonna-took-count-resets — the count starts over next turn, and for a new Belladonna object', () => {
    const ctx = pod('belladonna-reset');
    const belladonna = spawn(ctx, 'P1', card);
    token(ctx);
    token(ctx);
    const afterTwo = snapshot(ctx, belladonna);
    quietTurn(ctx);
    // The next turn's first resolution gains life again rather than counting a third.
    token(ctx);
    expect(snapshot(ctx, belladonna).life).toBe(afterTwo.life + 1);
    expect(snapshot(ctx, belladonna).counters).toBe(0);

    // A Belladonna that left and came back is a new object (CR 400.7) with a fresh count.
    const fresh = pod('belladonna-new-object');
    const first = spawn(fresh, 'P1', card);
    token(fresh);
    const before = playerById(fresh, 'P1').life;
    kill(fresh, first);
    const again = enterFrom(fresh, 'P1', card, 'graveyard');
    token(fresh);
    expect(playerById(fresh, 'P1').life).toBe(before + 1);
    expect(again.counters['+1/+1'] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.16 Rumor Gatherer
// ---------------------------------------------------------------------------------------------

describe('Rumor Gatherer', () => {
  const { card } = pinned('Rumor Gatherer');

  /** Put a creature onto P1's battlefield and resolve the triggers, counting scry prompts. */
  function enter(ctx: GameContext, name: string) {
    let scries = 0;
    enterFrom(ctx, 'P1', LAB_CARD(name), 'hand');
    settle(ctx, (decision) => {
      if (/: scry — /.test(decision.prompt)) scries += 1;
      return { index: 0, targets: new Map() };
    });
    return scries;
  }

  it('rumor-gatherer-pinned-oracle-supported — scry 1, replaced by a draw on the second resolution', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.effects).toMatchObject([
      {
        op: 'byResolutionCountThisTurn',
        cases: [{ n: 2, effects: [{ op: 'draw' }] }],
        otherwise: [{ op: 'scry', count: 1 }],
      },
    ]);
  });

  it('rumor-gatherer-second-draws-instead — first scry, second draw without scrying, third scry again', () => {
    const ctx = pod('rumor-sequence');
    spawn(ctx, 'P1', card);
    const hand = () => playerById(ctx, 'P1').hand.length;
    const start = hand();
    expect(enter(ctx, 'Lab One')).toBe(1);
    expect(hand()).toBe(start);
    expect(enter(ctx, 'Lab Two')).toBe(0);
    expect(hand()).toBe(start + 1);
    expect(enter(ctx, 'Lab Three')).toBe(1);
    expect(hand()).toBe(start + 1);
  });

  it('rumor-gatherer-another-creature — Rumor Gatherer entering, or an opponent’s creature, does not trigger it', () => {
    const ctx = pod('rumor-self');
    let scries = 0;
    enterFrom(ctx, 'P1', card, 'hand');
    enterFrom(ctx, 'P2', LAB_CARD('Lab Rival'), 'hand');
    settle(ctx, (decision) => {
      if (/: scry — /.test(decision.prompt)) scries += 1;
      return { index: 0, targets: new Map() };
    });
    expect(scries).toBe(0);
    expect(ctx.state.abilityResolutionsThisTurn ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// Primitive: cast ordinals number the spells that match the trigger's filter
// ---------------------------------------------------------------------------------------------

describe('Primitive: cast ordinals count matching spells', () => {
  const WATCHER = oracle({
    name: 'Lab Watcher',
    typeLine: 'Creature — Secret',
    power: '1',
    toughness: '1',
    oracleText:
      'Whenever an opponent casts their first noncreature spell each turn, you gain 3 life.',
  });
  const FLASH_BEAR = oracle({
    name: 'Lab Flash Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{0}',
    power: '2',
    toughness: '2',
    oracleText: 'Flash',
  });
  const QUICK = oracle({
    name: 'Lab Quick',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  it('cast-ordinal-matching-spells — a creature spell first does not use up “first noncreature spell”; the second noncreature does not trigger', () => {
    const ctx = pod('ordinal-noncreature');
    spawn(ctx, 'P1', WATCHER);
    const me = playerById(ctx, 'P1');
    const start = me.life;
    castFromHand(ctx, 'P2', FLASH_BEAR, []);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    castFromHand(ctx, 'P2', QUICK, []);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    settle(ctx);
    expect(me.life).toBe(start + 3);
    castFromHand(ctx, 'P2', QUICK, []);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    expect(me.life).toBe(start + 3);
    expect(playerById(ctx, 'P2').spellsCastThisTurnRecords?.map((r) => r.candidate.types)).toEqual([
      ['Creature'],
      ['Instant'],
      ['Instant'],
    ]);
  });

  it('cast-ordinal-matching-spells — the record clears at the start of each turn', () => {
    const ctx = pod('ordinal-reset');
    castFromHand(ctx, 'P1', QUICK, []);
    settle(ctx);
    expect(playerById(ctx, 'P1').spellsCastThisTurnRecords).toHaveLength(1);
    quietTurn(ctx);
    expect(playerById(ctx, 'P1').spellsCastThisTurnRecords ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.09 Crystal, Inhuman Princess
// ---------------------------------------------------------------------------------------------

describe('Crystal, Inhuman Princess', () => {
  const { card } = pinned('Crystal, Inhuman Princess');
  /** The fixture does not derive colors from the cost; a real card's colors come from it (CR 202.2). */
  const spell = (name: string, typeLine: string, manaCost: string) =>
    oracle({
      name,
      typeLine,
      manaCost,
      colors: (['W', 'U', 'B', 'R', 'G'] as const).filter((color) =>
        manaCost.includes(`{${color}}`),
      ),
      power: typeLine.startsWith('Creature') ? '1' : null,
      toughness: typeLine.startsWith('Creature') ? '1' : null,
      oracleText: typeLine.startsWith('Creature') ? 'Flash' : 'You gain 1 life.',
    });
  const lives = (ctx: GameContext) => ['P2', 'P3', 'P4'].map((id) => playerById(ctx, id).life);

  it('crystal-inhuman-princess-pinned-oracle-supported — flying, the four-color mana ability and the colors-of-that-spell damage trigger', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords).toContain('flying');
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'castsSpell',
      caster: 'you',
      filter: { kind: 'not', of: { kind: 'type', value: 'Creature' } },
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'eachOpponentDamage', amount: { kind: 'spellColorCount' } },
    ]);
  });

  it('crystal-inhuman-princess-colors-of-spell — a two-color instant deals 2 to each opponent, a three-color one 3', () => {
    const ctx = pod('crystal-colors');
    spawn(ctx, 'P1', card);
    const start = lives(ctx);
    castFromHand(ctx, 'P1', spell('Lab Gruul', 'Instant', '{R}{G}'), [
      { symbol: 'R' },
      { symbol: 'G' },
    ]);
    settle(ctx);
    expect(lives(ctx)).toEqual(start.map((life) => life - 2));
    castFromHand(ctx, 'P1', spell('Lab Naya', 'Instant', '{R}{G}{W}'), [
      { symbol: 'R' },
      { symbol: 'G' },
      ...white(1),
    ]);
    settle(ctx);
    expect(lives(ctx)).toEqual(start.map((life) => life - 5));
  });

  it('crystal-inhuman-princess-colorless — a colorless noncreature spell is zero colors, so no damage', () => {
    const ctx = pod('crystal-colorless');
    spawn(ctx, 'P1', card);
    const start = lives(ctx);
    castFromHand(ctx, 'P1', spell('Lab Gray', 'Instant', '{1}'), generic(1));
    settle(ctx);
    expect(lives(ctx)).toEqual(start);
  });

  it('crystal-inhuman-princess-noncreature-yours — your creature spells and an opponent’s spells do not trigger it', () => {
    const ctx = pod('crystal-filter');
    spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', spell('Lab Flash Ox', 'Creature — Ox', '{R}{G}'), [
      { symbol: 'R' },
      { symbol: 'G' },
    ]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    settle(ctx);
    castFromHand(ctx, 'P2', spell('Lab Theirs', 'Instant', '{R}{G}'), [
      { symbol: 'R' },
      { symbol: 'G' },
    ]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.07 Call Forth the Tempest
// ---------------------------------------------------------------------------------------------

describe('Call Forth the Tempest', () => {
  const { card } = pinned('Call Forth the Tempest');
  const instant = (name: string, manaCost: string) =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost,
      power: null,
      toughness: null,
      oracleText: 'You gain 1 life.',
    });
  const TOUGH = (name: string) =>
    oracle({ name, typeLine: 'Creature — Secret', power: '1', toughness: '10' });
  const red = (n: number) => Array.from({ length: n }, () => ({ symbol: 'R' as const }));

  /** Cast Call Forth from hand for its full cost and let everything (cascades included) resolve. */
  function callForth(ctx: GameContext) {
    castFromHand(ctx, 'P1', card, [...generic(5), ...red(3)]);
    settle(ctx);
  }

  it('call-forth-the-tempest-pinned-oracle-supported — two cascades and the other-spells damage', () => {
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.keywords.filter((keyword) => keyword === 'cascade')).toHaveLength(2);
    expect(def.spellAbility!.effects).toEqual([
      {
        op: 'damageEach',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'opponents' },
            { kind: 'type', value: 'Creature' },
          ],
        },
        amount: { kind: 'manaValueOfOtherSpellsCastThisTurn' },
      },
    ]);
  });

  it('call-forth-the-tempest-other-spells-total — two earlier spells (2 + 3) deal 5 to each opponent’s creature; its own 8 is not counted', () => {
    const ctx = pod('call-forth-total');
    const rival = spawn(ctx, 'P2', TOUGH('Lab Rival'));
    const ally = spawn(ctx, 'P1', TOUGH('Lab Ally'));
    castFromHand(ctx, 'P1', instant('Lab Two', '{2}'), generic(2));
    settle(ctx);
    castFromHand(ctx, 'P1', instant('Lab Three', '{3}'), generic(3));
    settle(ctx);
    callForth(ctx);
    expect(onField(ctx, rival.cardId)!.damageMarked).toBe(5);
    expect(onField(ctx, ally.cardId)!.damageMarked).toBe(0);
  });

  it('call-forth-the-tempest-yours-only — an opponent’s spells this turn do not count', () => {
    const ctx = pod('call-forth-theirs');
    const rival = spawn(ctx, 'P2', TOUGH('Lab Rival'));
    castFromHand(ctx, 'P2', instant('Lab Theirs', '{3}'), generic(3));
    settle(ctx);
    callForth(ctx);
    expect(onField(ctx, rival.cardId)!.damageMarked).toBe(0);
  });

  it('call-forth-the-tempest-cascades-count — spells cast by its own cascades are other spells cast this turn', () => {
    const ctx = pod('call-forth-cascade');
    const rival = spawn(ctx, 'P2', TOUGH('Lab Rival'));
    // Library top: Lab Cascade Two, then Lab Cascade Three — one hit for each cascade.
    conjure(ctx, 'P1', instant('Lab Cascade Three', '{3}'), 'library');
    conjure(ctx, 'P1', instant('Lab Cascade Two', '{2}'), 'library');
    castFromHand(ctx, 'P1', card, [...generic(5), ...red(3)]);
    settle(ctx, answers([[/cast/i, /^(Yes|Cast)/]]));
    expect(
      playerById(ctx, 'P1').spellsCastThisTurnRecords?.map((record) => record.manaValue),
    ).toEqual([8, 2, 3]);
    expect(onField(ctx, rival.cardId)!.damageMarked).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
// PR04.11 First Family
// ---------------------------------------------------------------------------------------------

describe('First Family', () => {
  const { card } = pinned('First Family');
  const FAMILY_MANA = [...generic(2), { symbol: 'G' as const }, { symbol: 'U' as const }];
  const colored = (name: string, typeLine: string, colors: ('W' | 'U' | 'B' | 'R' | 'G')[]) =>
    oracle({
      name,
      typeLine,
      manaCost: '{0}',
      colors,
      power: typeLine.startsWith('Creature') ? '1' : null,
      toughness: typeLine.startsWith('Creature') ? '1' : null,
      oracleText: typeLine.startsWith('Creature') ? '' : 'You gain 1 life.',
    });

  /** Cast First Family; returns how many cards P1 drew and how much life P1 gained from it. */
  function cast(ctx: GameContext) {
    const me = playerById(ctx, 'P1');
    castFromHand(ctx, 'P1', card, FAMILY_MANA);
    const hand = me.hand.length;
    const life = me.life;
    settle(ctx);
    return { drew: me.hand.length - hand, gained: me.life - life };
  }

  it('first-family-pinned-oracle-supported — draw X and gain X, X over permanents and spells cast this turn', () => {
    expectModeled(card);
    const value = { kind: 'colorsAmongPermanentsAndSpellsCastThisTurn' };
    expect(interpretCard(card).spellAbility!.effects).toEqual([
      { op: 'draw', count: value },
      { op: 'gainLife', amount: value },
    ]);
  });

  it('first-family-counts-itself — alone it is a green and blue spell you cast this turn, so X is 2', () => {
    const ctx = pod('family-alone');
    expect(cast(ctx)).toEqual({ drew: 2, gained: 2 });
  });

  it('first-family-permanents-and-spells — a red permanent and an earlier white spell add two more colors; repeats count once', () => {
    const ctx = pod('family-union');
    spawn(ctx, 'P1', colored('Lab Red', 'Creature — Secret', ['R']));
    spawn(ctx, 'P1', colored('Lab Green', 'Creature — Secret', ['G']));
    castFromHand(ctx, 'P1', colored('Lab White', 'Instant', ['W']), []);
    settle(ctx);
    expect(cast(ctx)).toEqual({ drew: 4, gained: 4 });
  });

  it('first-family-yours-only — an opponent’s permanents and spells add nothing', () => {
    const ctx = pod('family-theirs');
    spawn(ctx, 'P2', colored('Lab Their Red', 'Creature — Secret', ['R']));
    castFromHand(ctx, 'P2', colored('Lab Their Black', 'Instant', ['B']), []);
    settle(ctx);
    expect(cast(ctx)).toEqual({ drew: 2, gained: 2 });
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
    name: 'First Family',
    sha256: 'e81f7767b10c31b9b2a8751591afe24d39f155ca1780fd55ddcb03f805ce4a64',
    clauseCount: 1,
  },
  {
    name: 'Call Forth the Tempest',
    sha256: 'c48b93c22b22cbd4fc9fdac7bb9504e1651e7a9025e5e3bf58d675be756241f6',
    clauseCount: 2,
  },
  {
    name: 'Crystal, Inhuman Princess',
    sha256: '8a355e5c6a459e628aff3fb7c22a648424b60a76abf57295153c83289528c385',
    clauseCount: 3,
  },
  {
    name: 'Rumor Gatherer',
    sha256: 'd5b18ba7956be7118501bc486db3177a7bc8ebca881b24c031834ada00e7a19c',
    clauseCount: 1,
  },
  {
    name: 'Belladonna Took',
    sha256: '65b2c91a9085899dbe7b631298e7cc2893a867f894c885688c34f3a4d2c5525d',
    clauseCount: 1,
  },
  {
    name: 'Lockjaw, Slobbering Teleporter',
    sha256: 'c6552c5158eb975d6f921d85bb1c65dc4428f800b2d7d96d1cf753bb8060052a',
    clauseCount: 2,
  },
  {
    name: 'The Thing',
    sha256: 'dec568f46ce9c8621a6b2415d420f8b28d7a761f7a8d2c118642fc04c78b2792',
    clauseCount: 3,
  },
  {
    name: 'Aetheric Amplifier',
    sha256: '22243544923ec334e7ae37b5b5e30c9d3ba8372ba0dea881bcd3f07387177be6',
    clauseCount: 2,
  },
  {
    name: 'Bess, Soul Nourisher',
    sha256: '00655037d7422a06b8926f8538613d5998a3c10bd7cdf633b10aa75e91e592d9',
    clauseCount: 2,
  },
  {
    name: 'Mikey & Leo, Chaos & Order',
    sha256: '0c68ed59f882ea595ee50cbc36912ca70b5b4d5ef1a56bc503e3c532d2bd3b5a',
    clauseCount: 1,
  },
  {
    name: 'Pensive Professor',
    sha256: 'd1bbff061cf9949664fef0a0f27c26aae1413e512e17fc6b85db90ca429500e8',
    clauseCount: 2,
  },
  {
    name: 'Forgotten Ancient',
    sha256: '4024f52e734af98755f7494ab043fed6e9a7e9288ffb2fa538b8e0735ddb7d86',
    clauseCount: 2,
  },
  {
    name: 'Elite Scaleguard',
    sha256: 'f6c49e6ad315acd29a654a4090c9a9344d977650d14a6b943eebf671015e5b96',
    clauseCount: 2,
  },
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
