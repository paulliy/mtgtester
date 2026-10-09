/**
 * PR03 card coverage: zone-change history, last-known information, death and return
 * (docs/plans/card-coverage-chunks.md).
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
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { validateTriggerHead } from '../src/cards/trigger-contracts';
import type { TokenSpec } from '../src/cards/ability';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import {
  createToken,
  moveObject,
  movePermanentsToGraveyard,
  playerById,
} from '../src/state/objects';
import { effectivePT } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

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
const black = (n: number) => Array.from({ length: n }, () => ({ symbol: 'B' as const }));
const blue = (n: number) => Array.from({ length: n }, () => ({ symbol: 'U' as const }));
const red = (n: number) => Array.from({ length: n }, () => ({ symbol: 'R' as const }));

/** A fully interpreted instant, so a real spell can sit on the stack. */
const LAB_BOLT = oracle({
  name: 'Lab Bolt',
  typeLine: 'Instant',
  manaCost: '{R}',
  oracleText: 'Lab Bolt deals 3 damage to any target.',
});

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

const BEAR_TOKEN: TokenSpec = {
  name: 'Bear',
  typeLine: 'Token Creature — Bear',
  types: ['Creature'],
  subtypes: ['Bear'],
  colors: ['G'],
  power: 2,
  toughness: 2,
};

const LAB_CARD = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

// ---------------------------------------------------------------------------------------------
// Primitive: the zone a permanent entered from (CR 603.6a)
// ---------------------------------------------------------------------------------------------

describe('Primitive: enters-from-a-graveyard trigger head', () => {
  const watcher = oracle({
    name: 'Lab Grave Watcher',
    typeLine: 'Creature — Spirit',
    oracleText: 'Whenever another creature enters from your graveyard, draw a card.',
  });
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear' });

  it('enters-from-origin-primitive-your-graveyard — only a card from its controller’s own graveyard matches', () => {
    const ctx = pod('origin-yours');
    spawn(ctx, 'P1', watcher);
    enterFrom(ctx, 'P1', bear, 'graveyard');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Lab Grave Watcher',
    ]);
    ctx.state.pendingTriggers = [];
    // Stolen from an opponent's graveyard: it entered from a graveyard, but not from yours.
    const stolen = conjure(ctx, 'P2', bear, 'graveyard');
    pump(moveObject(ctx, stolen, { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toEqual([]);
    enterFrom(ctx, 'P1', bear, 'exile');
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('enters-from-origin-primitive-tokens-and-copies — a created token entered from no zone', () => {
    const ctx = pod('origin-token');
    spawn(ctx, 'P1', watcher);
    const token = createToken(ctx, BEAR_TOKEN, 'P1');
    expect(token.enteredFromZone).toBeUndefined();
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('enters-from-origin-primitive-contract — the restriction is valid only on an enters head', () => {
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'dies', subject: { kind: 'self' }, entersFrom: { zone: 'graveyard' } },
      'trigger',
      issues,
    );
    validateTriggerHead(
      { when: 'enters', subject: { kind: 'self' }, entersFrom: { zone: 'exile' } },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.entersFrom', 'trigger.entersFrom']);
    const ok: AuthoringIssue[] = [];
    validateTriggerHead(
      {
        when: 'enters',
        subject: { kind: 'self' },
        entersFrom: { zone: 'graveyard', graveyardOwner: 'you' },
      },
      'trigger',
      ok,
    );
    expect(ok).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.11 Triarch Praetorian
// ---------------------------------------------------------------------------------------------

describe('Triarch Praetorian', () => {
  const praetorian = pinned('Triarch Praetorian');

  /** P1's library holds three named cards so draws are visible. */
  function ready(seed: string) {
    const ctx = pod(seed);
    const p1 = playerById(ctx, 'P1');
    for (const name of ['Page Three', 'Page Two', 'Page One'])
      conjure(ctx, 'P1', LAB_CARD(name), 'library');
    return { ctx, p1 };
  }

  it('triarch-praetorian-pinned-oracle-supported — the interpreter alone models flying, the origin trigger and unearth', () => {
    expect(praetorian.sha256).toBe(
      '19702457c7e73d501b2509808cee1350b8f3944fc392e738b8f0080924578c9d',
    );
    expectNoRegistration(praetorian.card);
    expectModeled(praetorian.card);
    const def = interpretCard(praetorian.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'enters',
      subject: { kind: 'self' },
      entersFrom: { zone: 'graveyard' },
    });
    expect(def.activatedAbilities.map((entry) => entry.zone)).toEqual(['graveyard']);
  });

  it('triarch-praetorian-unearth-draws-two — unearthed from the graveyard, it draws two and loses 2 life', () => {
    const { ctx, p1 } = ready('praetorian-unearth');
    const card = conjure(ctx, 'P1', praetorian.card, 'graveyard');
    addMana(p1, [...generic(4), ...black(1)]);
    const option = optionFor(ctx, 'P1', card.id, /Unearth/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    // Unearth is an activated ability: the card stays in the graveyard until it resolves.
    expect(ctx.state.stack).toHaveLength(1);
    expect(p1.manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(p1.graveyard).toEqual([]);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId)!;
    expect(perm.enteredFromZone).toBe('graveyard');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Triarch Praetorian',
    ]);
    settle(ctx);
    expect(p1.hand.map((drawn) => drawn.name)).toEqual(['Page One', 'Page Two']);
    expect(p1.life).toBe(38);
  });

  it('triarch-praetorian-unearth-needs-mana-and-sorcery-timing — {4} or an opponent’s turn offers no unearth', () => {
    const short = ready('praetorian-unearth-short');
    const card = conjure(short.ctx, 'P1', praetorian.card, 'graveyard');
    addMana(short.p1, generic(4));
    expect(optionFor(short.ctx, 'P1', card.id, /Unearth/)).toBeUndefined();
    const offTurn = ready('praetorian-unearth-off-turn');
    const other = conjure(offTurn.ctx, 'P1', praetorian.card, 'graveyard');
    addMana(offTurn.p1, [...generic(4), ...black(1)]);
    offTurn.ctx.state.currentTurnPlayer = 'P2';
    offTurn.ctx.state.activePlayerIndex = 1;
    expect(optionFor(offTurn.ctx, 'P1', other.id, /Unearth/)).toBeUndefined();
  });

  it('triarch-praetorian-cast-from-hand-no-trigger — cast from hand it enters from the stack and draws nothing', () => {
    const { ctx, p1 } = ready('praetorian-cast');
    const card = conjure(ctx, 'P1', praetorian.card, 'hand');
    addMana(p1, [...generic(1), ...black(1)]);
    const option = optionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId)!;
    expect(perm.enteredFromZone).toBe('stack');
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    expect(p1.hand).toEqual([]);
    expect(p1.life).toBe(40);
  });

  it('triarch-praetorian-other-origins-no-trigger — entering from exile, hand or library does not trigger', () => {
    for (const zone of ['exile', 'hand', 'library'] as const) {
      const { ctx } = ready(`praetorian-${zone}`);
      enterFrom(ctx, 'P1', praetorian.card, zone);
      expect(ctx.state.pendingTriggers, zone).toEqual([]);
    }
  });

  it('triarch-praetorian-reanimated-triggers — any effect returning it from a graveyard triggers, under its new controller', () => {
    const { ctx } = ready('praetorian-reanimated');
    const perm = enterFrom(ctx, 'P2', praetorian.card, 'graveyard');
    expect(perm.controllerId).toBe('P2');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P2']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.01 Canoptek Tomb Sentinel
// ---------------------------------------------------------------------------------------------

describe('Canoptek Tomb Sentinel', () => {
  const sentinel = pinned('Canoptek Tomb Sentinel');
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const grove = oracle({ name: 'Lab Grove', typeLine: 'Land' });

  /** Choose `name` for the up-to-one slot, or no target at all. */
  const exileAnswer = (name: string | null): Answer =>
    answers([
      [
        /choose (a|another) target/i,
        name === null ? /Choose no more targets/ : new RegExp(`^Target ${name}$`),
      ],
    ]);

  function unearthed(seed: string, answer: Answer) {
    const ctx = pod(seed);
    const p1 = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', sentinel.card, 'graveyard');
    addMana(p1, generic(7));
    const option = optionFor(ctx, 'P1', card.id, /Unearth/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const settled = settle(ctx, answer);
    return { ctx, card, settled };
  }

  it('canoptek-tomb-sentinel-pinned-oracle-supported — the interpreter alone models vigilance, the origin exile and unearth', () => {
    expect(sentinel.sha256).toBe(
      '8b3b2b8d9dc4c7bc3c7dfa002de18cdd021d265cd16a45096e01e7e9ae29b87a',
    );
    expectNoRegistration(sentinel.card);
    expectModeled(sentinel.card);
    const def = interpretCard(sentinel.card);
    expect(def.keywords).toEqual(['vigilance']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'enters',
      subject: { kind: 'self' },
      entersFrom: { zone: 'graveyard' },
    });
    expect(def.triggers[0]!.targets).toEqual([
      { kind: 'nonlandPermanent', count: { min: 0, max: 1 } },
    ]);
    expect(def.triggers[0]!.effects).toEqual([{ op: 'exileEachChosen', targetSlot: 0 }]);
    expect(def.activatedAbilities.map((entry) => entry.zone)).toEqual(['graveyard']);
  });

  it("canoptek-tomb-sentinel-unearth-exiles — unearthed for {7}, it exiles an opponent's nonland permanent", () => {
    const ctx = pod('sentinel-exile');
    spawn(ctx, 'P2', relic);
    const p1 = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', sentinel.card, 'graveyard');
    addMana(p1, generic(7));
    const option = optionFor(ctx, 'P1', card.id, /Unearth/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    settle(ctx, exileAnswer('Lab Relic'));
    expect(ctx.state.battlefield.map((perm) => perm.name)).not.toContain('Lab Relic');
    expect(ctx.state.exile.map((exiled) => exiled.name)).toEqual(['Lab Relic']);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId)!;
    expect(perm.unearthed).toBe(true);
  });

  it('canoptek-tomb-sentinel-up-to-one — choosing no target exiles nothing, and lands are never offered', () => {
    const { ctx, settled } = unearthed('sentinel-none', exileAnswer(null));
    expect(ctx.state.exile).toEqual([]);
    const prompts = settled.decisions.filter((decision) =>
      /choose (a|another) target/i.test(decision.prompt),
    );
    expect(prompts).toHaveLength(1);
    const offered = prompts[0]!.options.map((option) => option.description);
    expect(offered).toContain('Choose no more targets');

    const withLand = pod('sentinel-land');
    spawn(withLand, 'P2', grove);
    spawn(withLand, 'P2', relic);
    const card = conjure(withLand, 'P1', sentinel.card, 'graveyard');
    addMana(playerById(withLand, 'P1'), generic(7));
    takeAction(
      withLand,
      'P1',
      optionFor(withLand, 'P1', card.id, /Unearth/)!.payload as PriorityActionPayload,
    );
    resolveTop(withLand);
    const seen: string[] = [];
    settle(withLand, (decision) => {
      if (/choose (a|another) target/i.test(decision.prompt)) {
        seen.push(...decision.options.map((option) => option.description));
        return optionMatching(decision, /Choose no more targets/);
      }
      return { index: 0, targets: new Map() };
    });
    expect(seen).toContain('Target Lab Relic');
    expect(seen).not.toContain('Target Lab Grove');
    expect(withLand.state.battlefield.map((perm) => perm.name)).toContain('Lab Grove');
  });

  it('canoptek-tomb-sentinel-cast-no-trigger — cast from hand for {4}, it exiles nothing', () => {
    const ctx = pod('sentinel-cast');
    spawn(ctx, 'P2', relic);
    const p1 = playerById(ctx, 'P1');
    const card = conjure(ctx, 'P1', sentinel.card, 'hand');
    addMana(p1, generic(4));
    const option = optionFor(ctx, 'P1', card.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx, exileAnswer('Lab Relic'));
    expect(ctx.state.battlefield.map((perm) => perm.name)).toContain('Lab Relic');
  });

  it('canoptek-tomb-sentinel-unearth-needs-seven — {6} offers no unearth', () => {
    const ctx = pod('sentinel-short');
    const card = conjure(ctx, 'P1', sentinel.card, 'graveyard');
    addMana(playerById(ctx, 'P1'), generic(6));
    expect(optionFor(ctx, 'P1', card.id, /Unearth/)).toBeUndefined();
  });

  it('up-to-one-removal-grammar — "destroy/exile up to one target X" reads as a 0..1 slot', () => {
    for (const [verb, op] of [
      ['destroy', 'destroyEachChosen'],
      ['exile', 'exileEachChosen'],
    ] as const) {
      const def = interpretCard(
        oracle({
          name: `Lab ${verb} Probe`,
          typeLine: 'Creature — Probe',
          oracleText: `When this creature enters, ${verb} up to one target artifact.`,
        }),
      );
      expect(def.modeled, verb).toBe(true);
      expect(def.triggers[0]!.targets).toEqual([{ kind: 'artifact', count: { min: 0, max: 1 } }]);
      expect(def.triggers[0]!.effects).toEqual([{ op, targetSlot: 0 }]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Primitive: persist and undying (CR 702.79a, 702.93a)
// ---------------------------------------------------------------------------------------------

describe('Primitive: persist and undying', () => {
  const undying = oracle({
    name: 'Lab Undying Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
    oracleText: 'Undying',
  });

  it('persist-undying-primitive-undying — undying returns it with a +1/+1 counter, once', () => {
    const ctx = pod('undying-primitive');
    const bear = spawn(ctx, 'P1', undying);
    kill(ctx, bear);
    settle(ctx);
    const back = onField(ctx, bear.cardId)!;
    expect(back.counters).toEqual({ '+1/+1': 1 });
    expect(back.enteredFromZone).toBe('graveyard');
    kill(ctx, back);
    settle(ctx);
    expect(onField(ctx, bear.cardId)).toBeUndefined();
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(['Lab Undying Bear']);
  });

  it('persist-undying-primitive-new-object — a card that left the graveyard and came back is not returned', () => {
    const ctx = pod('undying-new-object');
    const bear = spawn(ctx, 'P1', undying);
    kill(ctx, bear);
    // In response, the card is exiled and then put back: it is a new object (CR 400.7).
    const card = playerById(ctx, 'P1').graveyard[0]!;
    pump(moveObject(ctx, card, { zone: 'exile' }));
    pump(moveObject(ctx, ctx.state.exile[0]!, { zone: 'graveyard' }));
    settle(ctx);
    expect(onField(ctx, bear.cardId)).toBeUndefined();
  });

  it('persist-undying-primitive-token — a token with undying never returns', () => {
    const ctx = pod('undying-token');
    const token = spawn(ctx, 'P1', undying, { isToken: true });
    kill(ctx, token);
    settle(ctx);
    expect(ctx.state.battlefield.filter((perm) => perm.name === 'Lab Undying Bear')).toEqual([]);
  });

  it('persist-undying-primitive-simultaneous — each of two creatures dying together returns itself', () => {
    const ctx = pod('undying-together');
    const first = spawn(ctx, 'P1', undying);
    const second = spawn(ctx, 'P2', undying);
    pump(movePermanentsToGraveyard(ctx, [first, second]));
    settle(ctx);
    expect(onField(ctx, first.cardId)?.controllerId).toBe('P1');
    expect(onField(ctx, second.cardId)?.controllerId).toBe('P2');
  });
});

// ---------------------------------------------------------------------------------------------
// 3.03 Glen Elendra Archmage
// ---------------------------------------------------------------------------------------------

describe('Glen Elendra Archmage', () => {
  const archmage = pinned('Glen Elendra Archmage');

  /** P2 casts Lab Bolt at P1 through the normal cast path; it waits on the stack. */
  function boltOnStack(ctx: GameContext) {
    const bolt = conjure(ctx, 'P2', LAB_BOLT, 'hand');
    addMana(playerById(ctx, 'P2'), red(1));
    const option = optionFor(ctx, 'P2', bolt.id);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P2',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P1']]),
    );
    expect(ctx.state.stack.map((entry) => entry.description)).toEqual(['Lab Bolt']);
    return ctx.state.stack[0]!;
  }

  it('glen-elendra-archmage-pinned-oracle-supported — the interpreter alone models flying, the counter ability and persist', () => {
    expect(archmage.sha256).toBe(
      '13ec34cf29e69f3cc44cf9c8d95e931ce380bfb01361c0e6778e12daf91a9578',
    );
    expectNoRegistration(archmage.card);
    expectModeled(archmage.card);
    const def = interpretCard(archmage.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.activatedAbilities[0]!.costs).toEqual([
      expect.objectContaining({ kind: 'mana' }),
      { kind: 'sacrificeSelf' },
    ]);
    expect(def.activatedAbilities[0]!.ability.targets).toEqual([{ kind: 'noncreatureSpell' }]);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: {
          when: 'dies',
          subject: { kind: 'self' },
          condition: { kind: 'sourceHasCounters', counter: '-1/-1', cmp: '<=', n: 0 },
        },
        effects: [{ op: 'returnDiedSourceToBattlefield', counter: '-1/-1' }],
      }),
    ]);
  });

  it('glen-elendra-archmage-counter-and-persist — {U} and a sacrifice counter a noncreature spell, then persist returns it as a 1/1', () => {
    const ctx = pod('archmage-counter');
    const mage = spawn(ctx, 'P1', archmage.card);
    const bolt = boltOnStack(ctx);
    addMana(playerById(ctx, 'P1'), blue(1));
    const option = optionFor(ctx, 'P1', mage.id, /Counter target noncreature spell/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, bolt.id]]),
    );
    // Sacrificed as a cost: persist triggers above the counter ability.
    expect(onField(ctx, mage.cardId)).toBeUndefined();
    settle(ctx);
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Lab Bolt']);
    const back = onField(ctx, mage.cardId)!;
    expect(back.controllerId).toBe('P1');
    expect(back.counters).toEqual({ '-1/-1': 1 });
    expect(effectivePT(ctx, back)).toEqual({ power: 1, toughness: 1 });
  });

  it('glen-elendra-archmage-persist-once — with a -1/-1 counter it stays in the graveyard', () => {
    const ctx = pod('archmage-twice');
    const mage = spawn(ctx, 'P1', archmage.card);
    kill(ctx, mage);
    settle(ctx);
    const back = onField(ctx, mage.cardId)!;
    expect(back.counters).toEqual({ '-1/-1': 1 });
    kill(ctx, back);
    settle(ctx);
    expect(onField(ctx, mage.cardId)).toBeUndefined();
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Glen Elendra Archmage',
    ]);
  });

  it("glen-elendra-archmage-owner-control — a stolen Archmage returns under its owner's control", () => {
    const ctx = pod('archmage-owner');
    const mage = spawn(ctx, 'P1', archmage.card);
    mage.controllerId = 'P2';
    kill(ctx, mage);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P2']);
    settle(ctx);
    expect(onField(ctx, mage.cardId)?.controllerId).toBe('P1');
  });

  it('glen-elendra-archmage-creature-spells-not-targetable — a creature spell offers no counter target', () => {
    const ctx = pod('archmage-creature');
    const mage = spawn(ctx, 'P1', archmage.card);
    const bear = conjure(
      ctx,
      'P2',
      oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{1}' }),
      'hand',
    );
    addMana(playerById(ctx, 'P2'), generic(1));
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    takeAction(ctx, 'P2', optionFor(ctx, 'P2', bear.id)!.payload as PriorityActionPayload);
    addMana(playerById(ctx, 'P1'), blue(1));
    expect(optionFor(ctx, 'P1', mage.id, /Counter target noncreature spell/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 3.15 Flayer of the Hatebound
// ---------------------------------------------------------------------------------------------

describe('Flayer of the Hatebound', () => {
  const flayer = pinned('Flayer of the Hatebound');
  const ogre = oracle({
    name: 'Lab Ogre',
    typeLine: 'Creature — Ogre',
    power: '3',
    toughness: '3',
  });

  /** Aim every damage trigger at `target` (a player id or a permanent's name). */
  const aimAt =
    (target: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, target]]) };
      return { index: 0, targets: new Map() };
    };

  it('flayer-of-the-hatebound-pinned-oracle-supported — the interpreter alone models undying and the graveyard-origin damage trigger', () => {
    expect(flayer.sha256).toBe('83e8fbc4e2f4fd410df3e650ed4506fd40c65570897c3e5d7af777e88d35c7bc');
    expectNoRegistration(flayer.card);
    expectModeled(flayer.card);
    const def = interpretCard(flayer.card);
    expect(def.triggers.map((trigger) => trigger.description)).toEqual([
      'Undying',
      'Whenever this creature or another creature enters from your graveyard, that creature deals damage equal to its power to any target.',
    ]);
    expect(def.triggers[1]!.trigger).toMatchObject({
      when: 'enters',
      entersFrom: { zone: 'graveyard', graveyardOwner: 'you' },
    });
    expect(def.triggers[1]!.effects).toEqual([
      {
        op: 'dealDamage',
        target: 0,
        amount: { kind: 'powerOfTriggerObject' },
        source: 'triggerObject',
      },
    ]);
  });

  it('flayer-of-the-hatebound-undying-deals-five — dying without a counter, it returns as a 5/3 and deals 5 damage', () => {
    const ctx = pod('flayer-undying');
    const perm = spawn(ctx, 'P1', flayer.card);
    kill(ctx, perm);
    settle(ctx, aimAt('P2'));
    const back = onField(ctx, perm.cardId)!;
    expect(back.counters).toEqual({ '+1/+1': 1 });
    expect(effectivePT(ctx, back)).toEqual({ power: 5, toughness: 3 });
    expect(playerById(ctx, 'P2').life).toBe(35);
    const damage = ctx.state.eventLog.filter((event) => event.type === 'damage');
    expect(damage.at(-1)?.payload).toMatchObject({ source: 'Flayer of the Hatebound', amount: 5 });
  });

  it('flayer-of-the-hatebound-undying-once — with a +1/+1 counter it stays dead', () => {
    const ctx = pod('flayer-once');
    const perm = spawn(ctx, 'P1', flayer.card);
    kill(ctx, perm);
    settle(ctx, aimAt('P2'));
    kill(ctx, onField(ctx, perm.cardId)!);
    settle(ctx, aimAt('P2'));
    expect(onField(ctx, perm.cardId)).toBeUndefined();
    expect(playerById(ctx, 'P2').life).toBe(35);
  });

  it('flayer-of-the-hatebound-other-creature — another creature from your graveyard deals damage equal to its own power, as the source', () => {
    const ctx = pod('flayer-other');
    spawn(ctx, 'P1', flayer.card);
    const victim = spawn(
      ctx,
      'P3',
      oracle({ name: 'Lab Wall', typeLine: 'Creature — Wall', power: '0', toughness: '5' }),
    );
    enterFrom(ctx, 'P1', ogre, 'graveyard');
    settle(ctx, aimAt(victim.id));
    expect(onField(ctx, victim.cardId)?.damageMarked).toBe(3);
    const damage = ctx.state.eventLog.filter((event) => event.type === 'damage');
    expect(damage.at(-1)?.payload).toMatchObject({ source: 'Lab Ogre', amount: 3 });
  });

  it('flayer-of-the-hatebound-mass-return-sees-each — returned together, Flayer triggers for itself and every other creature (CR 603.6a)', () => {
    const ctx = pod('flayer-mass-return');
    // The Ogre is first in the graveyard: moved one at a time, it would enter before Flayer.
    conjure(ctx, 'P1', ogre, 'graveyard');
    conjure(ctx, 'P1', flayer.card, 'graveyard');
    const revive = oracle({
      name: 'Lab Mass Revival',
      typeLine: 'Sorcery',
      manaCost: '{1}',
      oracleText: 'Return all creature cards from your graveyard to the battlefield.',
    });
    castFromHand(ctx, 'P1', revive, generic(1));
    resolveTop(ctx);
    expect(ctx.state.battlefield.map((perm) => perm.name).sort()).toEqual([
      'Flayer of the Hatebound',
      'Lab Ogre',
    ]);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Flayer of the Hatebound',
      'Flayer of the Hatebound',
    ]);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(40 - 4 - 3);
  });

  it("flayer-of-the-hatebound-not-other-origins — a cast creature, an opponent's graveyard card or a token deals nothing", () => {
    const ctx = pod('flayer-negative');
    spawn(ctx, 'P1', flayer.card);
    enterFrom(ctx, 'P1', ogre, 'hand');
    enterFrom(ctx, 'P1', ogre, 'exile');
    const stolen = conjure(ctx, 'P2', ogre, 'graveyard');
    pump(moveObject(ctx, stolen, { zone: 'battlefield', controllerId: 'P1' }));
    createToken(ctx, BEAR_TOKEN, 'P1');
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.04 Kambal, Consul of Allocation
// ---------------------------------------------------------------------------------------------

describe('Kambal, Consul of Allocation', () => {
  const kambal = pinned('Kambal, Consul of Allocation');
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{1}' });

  it('kambal-pinned-oracle-supported — the interpreter alone models an opponent-cast noncreature trigger', () => {
    expect(kambal.sha256).toBe('803082206730781d6c0b080302b0679ed14e54b7d5b3f0096d15d7bc0d2edf71');
    expectNoRegistration(kambal.card);
    expectModeled(kambal.card);
    const def = interpretCard(kambal.card);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'castsSpell',
      caster: 'opponent',
      filter: { kind: 'not', of: { kind: 'type', value: 'Creature' } },
    });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'loseLifeTarget', target: 'eventPlayer', amount: { kind: 'const', n: 2 } },
      { op: 'gainLife', amount: { kind: 'const', n: 2 } },
    ]);
  });

  it('kambal-opponent-noncreature-spell — the casting opponent loses 2 and Kambal’s controller gains 2, before the spell resolves', () => {
    const ctx = pod('kambal-opponent');
    spawn(ctx, 'P1', kambal.card);
    castFromHand(ctx, 'P2', LAB_BOLT, red(1), new Map([[0, 'P1']]));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P1']);
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(playerById(ctx, 'P1').life).toBe(40 + 2 - 3);
    const life = ctx.state.eventLog.filter(
      (event) => event.type === 'lifeLoss' || event.type === 'lifeGain' || event.type === 'damage',
    );
    expect(life.map((event) => event.type)).toEqual(['lifeLoss', 'lifeGain', 'damage']);
  });

  it('kambal-another-opponent — each opponent who casts is the one who pays', () => {
    const ctx = pod('kambal-p3');
    spawn(ctx, 'P1', kambal.card);
    castFromHand(ctx, 'P3', LAB_BOLT, red(1), new Map([[0, 'P2']]));
    settle(ctx);
    expect(playerById(ctx, 'P3').life).toBe(38);
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(playerById(ctx, 'P1').life).toBe(42);
  });

  it('kambal-own-and-creature-spells — your own noncreature spell and an opponent’s creature spell do nothing', () => {
    const ctx = pod('kambal-negative');
    spawn(ctx, 'P1', kambal.card);
    castFromHand(ctx, 'P1', LAB_BOLT, red(1), new Map([[0, 'P2']]));
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', bear, generic(1));
    expect(ctx.state.stack.map((entry) => entry.description)).toEqual(['Lab Bear']);
    expect(ctx.state.pendingTriggers).toEqual([]);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.16 Gleeful Arsonist
// ---------------------------------------------------------------------------------------------

describe('Gleeful Arsonist', () => {
  const arsonist = pinned('Gleeful Arsonist');
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{1}' });

  it('gleeful-arsonist-pinned-oracle-supported — the interpreter alone models the opponent-cast damage and undying', () => {
    expect(arsonist.sha256).toBe(
      'b4a3ce9d3e4fe7ed7f998c785be7bba031639225544a3a577952cd0bfe875143',
    );
    expectNoRegistration(arsonist.card);
    expectModeled(arsonist.card);
    const def = interpretCard(arsonist.card);
    expect(def.triggers.map((trigger) => trigger.trigger?.when)).toEqual(['castsSpell', 'dies']);
    expect(def.triggers[0]!.trigger).toMatchObject({ caster: 'opponent' });
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'dealDamage', target: 'eventPlayer', amount: { kind: 'powerOfSource' } },
    ]);
    expect(def.triggers[1]!.effects).toEqual([
      { op: 'returnDiedSourceToBattlefield', counter: '+1/+1' },
    ]);
  });

  it('gleeful-arsonist-damages-caster — an opponent’s noncreature spell takes damage equal to its power, from the Arsonist', () => {
    const ctx = pod('arsonist-damage');
    spawn(ctx, 'P1', arsonist.card);
    castFromHand(ctx, 'P3', LAB_BOLT, red(1), new Map([[0, 'P2']]));
    settle(ctx);
    expect(playerById(ctx, 'P3').life).toBe(39);
    const damage = ctx.state.eventLog.filter((event) => event.type === 'damage');
    expect(damage[0]?.payload).toMatchObject({
      source: expect.stringMatching(/^Gleeful Arsonist/),
      amount: 1,
    });
  });

  it('gleeful-arsonist-power-on-resolution — its power when the trigger resolves sets the damage', () => {
    const ctx = pod('arsonist-pumped');
    const perm = spawn(ctx, 'P1', arsonist.card);
    castFromHand(ctx, 'P2', LAB_BOLT, red(1), new Map([[0, 'P1']]));
    perm.counters = { '+1/+1': 2 };
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(37);
  });

  it('gleeful-arsonist-undying-then-two — undying returns it as a 2/3 that deals 2', () => {
    const ctx = pod('arsonist-undying');
    const perm = spawn(ctx, 'P1', arsonist.card);
    kill(ctx, perm);
    settle(ctx);
    const back = onField(ctx, perm.cardId)!;
    expect(back.counters).toEqual({ '+1/+1': 1 });
    expect(effectivePT(ctx, back)).toEqual({ power: 2, toughness: 3 });
    castFromHand(ctx, 'P2', LAB_BOLT, red(1), new Map([[0, 'P1']]));
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(38);
    kill(ctx, back);
    settle(ctx);
    expect(onField(ctx, perm.cardId)).toBeUndefined();
  });

  it('gleeful-arsonist-own-and-creature-spells — your own noncreature spell and an opponent’s creature spell do nothing', () => {
    const ctx = pod('arsonist-negative');
    spawn(ctx, 'P1', arsonist.card);
    castFromHand(ctx, 'P1', LAB_BOLT, red(1), new Map([[0, 'P2']]));
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', bear, generic(1));
    expect(ctx.state.pendingTriggers).toEqual([]);
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

/** Cards restored in PR03. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Gleeful Arsonist',
    sha256: 'b4a3ce9d3e4fe7ed7f998c785be7bba031639225544a3a577952cd0bfe875143',
    clauseCount: 2,
  },
  {
    name: 'Kambal, Consul of Allocation',
    sha256: '803082206730781d6c0b080302b0679ed14e54b7d5b3f0096d15d7bc0d2edf71',
    clauseCount: 1,
  },
  {
    name: 'Flayer of the Hatebound',
    sha256: '83e8fbc4e2f4fd410df3e650ed4506fd40c65570897c3e5d7af777e88d35c7bc',
    clauseCount: 2,
  },
  {
    name: 'Glen Elendra Archmage',
    sha256: '13ec34cf29e69f3cc44cf9c8d95e931ce380bfb01361c0e6778e12daf91a9578',
    clauseCount: 3,
  },
  {
    name: 'Canoptek Tomb Sentinel',
    sha256: '8b3b2b8d9dc4c7bc3c7dfa002de18cdd021d265cd16a45096e01e7e9ae29b87a',
    clauseCount: 3,
  },
  {
    name: 'Triarch Praetorian',
    sha256: '19702457c7e73d501b2509808cee1350b8f3944fc392e738b8f0080924578c9d',
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

describe('PR03 restoration gate', () => {
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
      (entry) => entry.restoredIn === 'coverage-pr03',
    );
    expect(ours.length).toBeGreaterThan(0);
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
