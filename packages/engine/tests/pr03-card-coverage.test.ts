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
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { validateTriggerHead } from '../src/cards/trigger-contracts';
import type { Effect, TokenSpec } from '../src/cards/ability';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { MUTAGEN } from '../src/cards/tokens';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { beginEndStep, runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import {
  createToken,
  moveObject,
  moveObjects,
  movePermanentsToGraveyard,
  playerById,
} from '../src/state/objects';
import { computeCharacteristics } from '../src/effects/continuous';
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
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json', 'fixtures/coverage-pr03-oracle.json'];
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
const green = (n: number) => Array.from({ length: n }, () => ({ symbol: 'G' as const }));
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

  it('enters-from-origin-primitive-graveyard-and-emblem-watchers — a graveyard card or an emblem with the restriction honors it too', () => {
    const ctx = pod('origin-other-sources');
    const def = interpretCard(watcher);
    const ability = { ...def.triggers[0]!, functionsInGraveyard: true as const };
    registerCustomDef(ctx, { ...def, triggers: [ability] });
    conjure(ctx, 'P1', watcher, 'graveyard');
    playerById(ctx, 'P1').emblems.push({
      id: 'lab-emblem',
      name: 'Lab Emblem',
      controllerId: 'P1',
      abilities: [ability],
    });
    enterFrom(ctx, 'P1', bear, 'hand');
    expect(ctx.state.pendingTriggers).toEqual([]);
    enterFrom(ctx, 'P1', bear, 'graveyard');
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName).sort()).toEqual([
      'Lab Emblem',
      'Lab Grave Watcher',
    ]);
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
// Primitive: the cast record (CR 601.2) and 3.09 Shard of the Nightbringer
// ---------------------------------------------------------------------------------------------

describe('Shard of the Nightbringer', () => {
  const shard = pinned('Shard of the Nightbringer');
  const SHARD_MANA = () => [...generic(5), ...black(3)];

  /** Aim the trigger's target-opponent slot at `player`. */
  const aimAt =
    (player: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, player]]) };
      return { index: 0, targets: new Map() };
    };

  it('shard-of-the-nightbringer-pinned-oracle-supported — the interpreter alone models flying and the if-you-cast-it drain', () => {
    expect(shard.sha256).toBe('4c7f7779f494bcf3ef533a08cb6e5c2569a29f7845c354e2d31bb827a925ae3a');
    expectNoRegistration(shard.card);
    expectModeled(shard.card);
    const def = interpretCard(shard.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'enters',
      subject: { kind: 'self' },
      condition: { kind: 'sourceWasCast' },
    });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'loseHalfLifeTarget', target: 0 },
      { op: 'gainLifeEqualToLifeLostThisWay' },
    ]);
  });

  it('cast-record-primitive — a cast permanent records its caster, origin zone and mana spent; nothing else does', () => {
    const ctx = pod('cast-record');
    const card = castFromHand(ctx, 'P1', shard.card, SHARD_MANA());
    expect(ctx.state.stack[0]!.card).toMatchObject({
      castByPlayerId: 'P1',
      castFromZone: 'hand',
      manaSpentToCast: 8,
    });
    resolveTop(ctx);
    expect(onField(ctx, card.cardId)).toMatchObject({
      castByPlayerId: 'P1',
      castFromZone: 'hand',
      manaSpentToCast: 8,
      enteredFromZone: 'stack',
    });
    const reanimated = enterFrom(ctx, 'P1', shard.card, 'graveyard');
    expect(reanimated.castByPlayerId).toBeUndefined();
    // Dying and coming back drops the record: the new object was not cast.
    const cast = onField(ctx, card.cardId)!;
    kill(ctx, cast);
    expect(playerById(ctx, 'P1').graveyard.at(-1)?.castByPlayerId).toBeUndefined();
  });

  it('shard-of-the-nightbringer-cast-drains-half — cast for its cost, target opponent loses half their life and you gain that much', () => {
    const ctx = pod('shard-cast');
    castFromHand(ctx, 'P1', shard.card, SHARD_MANA());
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Shard of the Nightbringer',
    ]);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(20);
    expect(playerById(ctx, 'P1').life).toBe(60);
  });

  it('shard-of-the-nightbringer-rounded-up — an odd life total loses the larger half', () => {
    const ctx = pod('shard-odd');
    playerById(ctx, 'P3').life = 15;
    castFromHand(ctx, 'P1', shard.card, SHARD_MANA());
    resolveTop(ctx);
    settle(ctx, aimAt('P3'));
    expect(playerById(ctx, 'P3').life).toBe(7);
    expect(playerById(ctx, 'P1').life).toBe(48);
  });

  it('shard-of-the-nightbringer-not-cast-no-trigger — reanimated, or put onto the battlefield from hand, it drains nothing', () => {
    for (const zone of ['graveyard', 'hand', 'exile'] as const) {
      const ctx = pod(`shard-${zone}`);
      enterFrom(ctx, 'P1', shard.card, zone);
      expect(ctx.state.pendingTriggers, zone).toEqual([]);
    }
  });

  it('shard-of-the-nightbringer-opponents-only — only an opponent can be targeted, never you', () => {
    const ctx = pod('shard-targets');
    castFromHand(ctx, 'P1', shard.card, SHARD_MANA());
    resolveTop(ctx);
    const { decisions } = settle(ctx, aimAt('P4'));
    const slot = decisions.flatMap((decision) => decision.options[0]?.targets ?? [])[0];
    expect(slot?.options.sort()).toEqual(['P2', 'P3', 'P4']);
    expect(playerById(ctx, 'P4').life).toBe(20);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.07 Satoru, the Infiltrator
// ---------------------------------------------------------------------------------------------

describe('Satoru, the Infiltrator', () => {
  const satoru = pinned('Satoru, the Infiltrator');
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{1}' });
  const thopter = oracle({
    name: 'Lab Ornithopter',
    typeLine: 'Artifact Creature — Thopter',
    manaCost: '{0}',
  });

  /** P1's library holds named cards so a draw is visible. */
  function ready(seed: string) {
    const ctx = pod(seed);
    for (const name of ['Page Two', 'Page One']) conjure(ctx, 'P1', LAB_CARD(name), 'library');
    return ctx;
  }
  const hand = (ctx: GameContext) => playerById(ctx, 'P1').hand.map((card) => card.name);

  it('satoru-the-infiltrator-pinned-oracle-supported — the interpreter alone models menace and the uncast-or-free enters draw', () => {
    expect(satoru.sha256).toBe('61506504750f785352e9318aa606928d134418fd60f7036ea0a1c5c971b5b564');
    expectNoRegistration(satoru.card);
    expectModeled(satoru.card);
    const def = interpretCard(satoru.card);
    expect(def.keywords).toEqual(['menace']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'enters',
      aggregate: true,
      entersWithoutManaSpentToCast: true,
    });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
  });

  it('satoru-the-infiltrator-cast-with-mana-no-draw — casting Satoru or a creature for mana draws nothing', () => {
    const ctx = ready('satoru-cast');
    castFromHand(ctx, 'P1', satoru.card, [...blue(1), ...black(1)]);
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers).toEqual([]);
    castFromHand(ctx, 'P1', bear, generic(1));
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    expect(hand(ctx)).toEqual([]);
  });

  it('satoru-the-infiltrator-not-cast-draws — Satoru or another nontoken creature put onto the battlefield draws a card', () => {
    const ctx = ready('satoru-put');
    enterFrom(ctx, 'P1', satoru.card, 'hand');
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One']);
    enterFrom(ctx, 'P1', bear, 'graveyard');
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One', 'Page Two']);
  });

  it('satoru-the-infiltrator-free-cast-draws — a creature cast with no mana spent draws a card', () => {
    const ctx = ready('satoru-free');
    spawn(ctx, 'P1', satoru.card);
    castFromHand(ctx, 'P1', thopter, []);
    expect(ctx.state.stack[0]!.card).toMatchObject({ manaSpentToCast: 0 });
    resolveTop(ctx);
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One']);
  });

  it('satoru-the-infiltrator-one-or-more — two creatures entering together draw one card', () => {
    const ctx = ready('satoru-together');
    spawn(ctx, 'P1', satoru.card);
    const first = conjure(ctx, 'P1', bear, 'graveyard');
    const second = conjure(ctx, 'P1', bear, 'graveyard');
    pump(moveObjects(ctx, [first, second], { zone: 'battlefield', controllerId: 'P1' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One']);
  });

  it('enters-batch-doubling-per-firing — with Panharmonicon, only the creature in a land-and-creature batch is doubled', () => {
    const ctx = pod('enters-batch-doubling');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Panharmonicon',
        typeLine: 'Artifact',
        manaCost: '{4}',
        oracleText:
          'If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.',
      }),
    );
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Life Watcher',
        typeLine: 'Enchantment',
        oracleText: 'Whenever another permanent you control enters, you gain 1 life.',
      }),
    );
    const land = conjure(ctx, 'P1', oracle({ name: 'Lab Grove', typeLine: 'Land' }), 'graveyard');
    const creature = conjure(ctx, 'P1', bear, 'graveyard');
    pump(moveObjects(ctx, [land, creature], { zone: 'battlefield', controllerId: 'P1' }));
    expect(
      ctx.state.pendingTriggers.filter((t) => t.sourceName === 'Lab Life Watcher'),
    ).toHaveLength(3);
  });

  it("satoru-the-infiltrator-tokens-and-opponents — a token or an opponent's creature draws nothing", () => {
    const ctx = ready('satoru-negative');
    spawn(ctx, 'P1', satoru.card);
    createToken(ctx, BEAR_TOKEN, 'P1');
    enterFrom(ctx, 'P2', bear, 'graveyard');
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('enters-without-mana-primitive-other-sources — a graveyard or emblem watcher with the restriction honors it too', () => {
    const ctx = ready('satoru-other-sources');
    const def = interpretCard(satoru.card);
    const ability = {
      ...def.triggers[0]!,
      trigger: {
        when: 'enters' as const,
        subject: {
          kind: 'permanent' as const,
          selector: { kind: 'type' as const, value: 'Creature' },
        },
        entersWithoutManaSpentToCast: true as const,
      },
      functionsInGraveyard: true as const,
    };
    registerCustomDef(ctx, { ...def, triggers: [ability] });
    conjure(ctx, 'P1', satoru.card, 'graveyard');
    playerById(ctx, 'P1').emblems.push({
      id: 'lab-emblem',
      name: 'Lab Emblem',
      controllerId: 'P1',
      abilities: [ability],
    });
    castFromHand(ctx, 'P1', bear, generic(1));
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers).toEqual([]);
    enterFrom(ctx, 'P1', bear, 'graveyard');
    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it('enters-without-mana-primitive-contract — the restriction is valid only on an enters head', () => {
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'dies', subject: { kind: 'self' }, entersWithoutManaSpentToCast: true },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.entersWithoutManaSpentToCast']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.26 Keeper of Secrets
// ---------------------------------------------------------------------------------------------

describe('Keeper of Secrets', () => {
  const keeper = pinned('Keeper of Secrets');
  const flashBolt = oracle({
    name: 'Lab Flash Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Lab Flash Bolt deals 1 damage to any target.\nFlashback {1}{R}',
  });
  const general = oracle({
    name: 'Lab General',
    typeLine: 'Legendary Creature — Human',
    manaCost: '{2}{R}',
    power: '2',
    toughness: '2',
  });

  /** Answer every target prompt: Keeper's trigger aims at `opponent`, spells at `spellTarget`. */
  const aim =
    (opponent: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, opponent]]) };
      return { index: 0, targets: new Map() };
    };

  it('keeper-of-secrets-pinned-oracle-supported — the interpreter alone models first strike, haste and the not-from-hand cast trigger', () => {
    expect(keeper.sha256).toBe('4ef53442c20bda37718ff851155d979ab82ef135f39dc7da1f7076c9a88bdc5a');
    expect(keeper.card.oracleText).toBe(
      "First strike, haste\nSymphony of Pain — Whenever you cast a spell from anywhere other than your hand, this creature deals damage equal to that spell's mana value to target opponent.",
    );
    expectModeled(keeper.card);
    const def = interpretCard(keeper.card);
    expect(def.keywords).toEqual(['first strike', 'haste']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'castsSpell',
      caster: 'you',
      castFrom: 'notHand',
    });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'spellManaValue' } },
    ]);
  });

  it('keeper-of-secrets-flashback-from-graveyard — a spell cast from the graveyard deals its mana value to target opponent', () => {
    const ctx = pod('keeper-flashback');
    spawn(ctx, 'P1', keeper.card);
    const bolt = conjure(ctx, 'P1', flashBolt, 'graveyard');
    addMana(playerById(ctx, 'P1'), [...generic(1), ...red(1)]);
    const option = optionFor(ctx, 'P1', bolt.id);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P3']]),
    );
    expect(ctx.state.stack[0]!.card).toMatchObject({ castFromZone: 'graveyard' });
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Keeper of Secrets',
    ]);
    settle(ctx, aim('P2'));
    // The trigger's 1 (the spell's mana value) at P2, then the bolt's 1 at P3.
    expect(playerById(ctx, 'P2').life).toBe(39);
    expect(playerById(ctx, 'P3').life).toBe(39);
  });

  it('keeper-of-secrets-command-zone — casting a commander deals that spell’s mana value', () => {
    const ctx = pod('keeper-commander');
    spawn(ctx, 'P1', keeper.card);
    const commander = conjure(ctx, 'P1', general, 'command', { isCommander: true });
    playerById(ctx, 'P1').commanderCardIds.push(commander.cardId);
    addMana(playerById(ctx, 'P1'), [...generic(2), ...red(1)]);
    const option = optionFor(ctx, 'P1', commander.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    settle(ctx, aim('P4'));
    expect(playerById(ctx, 'P4').life).toBe(37);
  });

  it('keeper-of-secrets-from-hand-no-trigger — a spell cast from your hand does nothing', () => {
    const ctx = pod('keeper-hand');
    spawn(ctx, 'P1', keeper.card);
    castFromHand(ctx, 'P1', flashBolt, red(1), new Map([[0, 'P2']]));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it("keeper-of-secrets-opponents-spells — an opponent's flashback does not trigger it", () => {
    const ctx = pod('keeper-opponent');
    spawn(ctx, 'P1', keeper.card);
    const bolt = conjure(ctx, 'P2', flashBolt, 'graveyard');
    addMana(playerById(ctx, 'P2'), [...generic(1), ...red(1)]);
    takeAction(
      ctx,
      'P2',
      optionFor(ctx, 'P2', bolt.id)!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P1']]),
    );
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('cast-origin-primitive-contract — an unknown origin restriction is rejected', () => {
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'castsSpell', caster: 'you', castFrom: 'exile' },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.castFrom']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.21 River Kelpie
// ---------------------------------------------------------------------------------------------

describe('River Kelpie', () => {
  const kelpie = pinned('River Kelpie');
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const flashBolt = oracle({
    name: 'Lab Flash Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText: 'Lab Flash Bolt deals 1 damage to any target.\nFlashback {1}{R}',
  });

  function ready(seed: string) {
    const ctx = pod(seed);
    for (const name of ['Page Three', 'Page Two', 'Page One'])
      conjure(ctx, 'P1', LAB_CARD(name), 'library');
    return ctx;
  }
  const hand = (ctx: GameContext) => playerById(ctx, 'P1').hand.map((card) => card.name);

  it('river-kelpie-pinned-oracle-supported — the interpreter alone models both graveyard triggers and persist', () => {
    expect(kelpie.sha256).toBe('d37cb44668d016bedab1375e97e13f1a178fadacc72ce65b5d17bc0509048c2c');
    expectNoRegistration(kelpie.card);
    expectModeled(kelpie.card);
    const def = interpretCard(kelpie.card);
    expect(def.triggers.map((trigger) => trigger.trigger)).toEqual([
      {
        when: 'enters',
        subject: {
          kind: 'permanent',
          selector: { kind: 'anyOf', of: [{ kind: 'self' }, { kind: 'other' }] },
        },
        entersFrom: { zone: 'graveyard' },
      },
      { when: 'castsSpell', caster: 'each', castFrom: 'graveyard' },
      expect.objectContaining({ when: 'dies', subject: { kind: 'self' } }),
    ]);
  });

  it('river-kelpie-persist-draws — persist returns it, and its own trigger draws a card', () => {
    const ctx = ready('kelpie-persist');
    const perm = spawn(ctx, 'P1', kelpie.card);
    kill(ctx, perm);
    settle(ctx);
    expect(onField(ctx, perm.cardId)?.counters).toEqual({ '-1/-1': 1 });
    expect(hand(ctx)).toEqual(['Page One']);
    kill(ctx, onField(ctx, perm.cardId)!);
    settle(ctx);
    expect(onField(ctx, perm.cardId)).toBeUndefined();
    expect(hand(ctx)).toEqual(['Page One']);
  });

  it("river-kelpie-another-permanent — any permanent entering from any player's graveyard draws a card", () => {
    const ctx = ready('kelpie-other');
    spawn(ctx, 'P1', kelpie.card);
    enterFrom(ctx, 'P2', relic, 'graveyard');
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One']);
  });

  it('river-kelpie-spell-from-graveyard — any player casting a spell from a graveyard draws a card', () => {
    const ctx = ready('kelpie-cast');
    spawn(ctx, 'P1', kelpie.card);
    const bolt = conjure(ctx, 'P3', flashBolt, 'graveyard');
    addMana(playerById(ctx, 'P3'), [...generic(1), ...red(1)]);
    takeAction(
      ctx,
      'P3',
      optionFor(ctx, 'P3', bolt.id)!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P2']]),
    );
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.controllerId)).toEqual(['P1']);
    settle(ctx);
    expect(hand(ctx)).toEqual(['Page One']);
  });

  it('river-kelpie-other-origins-no-draw — a spell from hand, or a permanent entering from hand or exile, draws nothing', () => {
    const ctx = ready('kelpie-negative');
    spawn(ctx, 'P1', kelpie.card);
    castFromHand(ctx, 'P2', flashBolt, red(1), new Map([[0, 'P1']]));
    enterFrom(ctx, 'P1', relic, 'hand');
    enterFrom(ctx, 'P1', relic, 'exile');
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.23 Aurora Phoenix
// ---------------------------------------------------------------------------------------------

describe('Aurora Phoenix', () => {
  const phoenix = pinned('Aurora Phoenix');
  const cascader = oracle({
    name: 'Lab Cascader',
    typeLine: 'Creature — Elemental',
    manaCost: '{2}{R}',
    power: '2',
    toughness: '2',
    oracleText: 'Cascade',
    keywords: ['Cascade'],
  });
  const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear', manaCost: '{1}' });

  /** Libraries hold only lands, so a cascade exiles them, finds nothing and bottoms them. */
  function ready(seed: string) {
    const ctx = pod(seed);
    return ctx;
  }
  const inHand = (ctx: GameContext, id: string) =>
    playerById(ctx, id).hand.map((card) => card.name);

  it('aurora-phoenix-pinned-oracle-supported — flying and cascade are interpreted; the cascade-cast return works from the graveyard', () => {
    expect(phoenix.sha256).toBe('4149988023167dc979f17457a84b42f8b357c111b9df094f8239783b568823db');
    expectModeled(phoenix.card);
    const def = interpretCard(phoenix.card);
    expect(def.keywords).toEqual(['flying', 'cascade']);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: {
          when: 'castsSpell',
          caster: 'you',
          filter: { kind: 'hasKeyword', keyword: 'cascade' },
        },
        functionsInGraveyard: true,
        effects: [{ op: 'returnSelfFromGraveyardToHand' }],
      }),
    ]);
  });

  it('aurora-phoenix-cascade-returns — casting a spell with cascade returns it from the graveyard to your hand', () => {
    const ctx = ready('phoenix-return');
    conjure(ctx, 'P1', phoenix.card, 'graveyard');
    castFromHand(ctx, 'P1', cascader, [...generic(2), ...red(1)]);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toContain(
      'Aurora Phoenix',
    );
    settle(ctx);
    expect(inHand(ctx, 'P1')).toEqual(['Aurora Phoenix']);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
  });

  it('aurora-phoenix-casting-a-phoenix — casting another Aurora Phoenix (it has cascade) returns the one in the graveyard', () => {
    const ctx = ready('phoenix-phoenix');
    const buried = conjure(ctx, 'P1', phoenix.card, 'graveyard');
    castFromHand(ctx, 'P1', phoenix.card, [...generic(4), ...red(2)]);
    settle(ctx);
    expect(playerById(ctx, 'P1').hand.map((card) => card.cardId)).toEqual([buried.cardId]);
  });

  it('aurora-phoenix-not-other-spells — a spell without cascade, or an opponent’s cascade spell, returns nothing', () => {
    const ctx = ready('phoenix-negative');
    conjure(ctx, 'P1', phoenix.card, 'graveyard');
    castFromHand(ctx, 'P1', bear, generic(1));
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castFromHand(ctx, 'P2', cascader, [...generic(2), ...red(1)]);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).not.toContain(
      'Aurora Phoenix',
    );
  });

  it('aurora-phoenix-only-from-graveyard — on the battlefield, or after it left the graveyard and came back, it does nothing', () => {
    const onBattlefield = ready('phoenix-battlefield');
    spawn(onBattlefield, 'P1', phoenix.card);
    castFromHand(onBattlefield, 'P1', cascader, [...generic(2), ...red(1)]);
    expect(onBattlefield.state.pendingTriggers.map((trigger) => trigger.sourceName)).not.toContain(
      'Aurora Phoenix',
    );

    const ctx = ready('phoenix-new-object');
    const card = conjure(ctx, 'P1', phoenix.card, 'graveyard');
    castFromHand(ctx, 'P1', cascader, [...generic(2), ...red(1)]);
    // In response the card is exiled and put back: the trigger's object is gone (CR 400.7).
    pump(moveObject(ctx, playerById(ctx, 'P1').graveyard[0]!, { zone: 'exile' }));
    pump(
      moveObject(
        ctx,
        ctx.state.exile.find((c) => c.cardId === card.cardId)!,
        { zone: 'graveyard' },
      ),
    );
    settle(ctx);
    expect(inHand(ctx, 'P1')).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard.map((c) => c.name)).toEqual(['Aurora Phoenix']);
  });
});

// ---------------------------------------------------------------------------------------------
// Primitive: leaves the battlefield, and 3.13 Watcher for Tomorrow
// ---------------------------------------------------------------------------------------------

describe('Watcher for Tomorrow', () => {
  const watcher = pinned('Watcher for Tomorrow');

  /** P1's library holds four named cards for the Hideaway look. */
  function ready(seed: string) {
    const ctx = pod(seed);
    playerById(ctx, 'P1').library = [];
    for (const name of ['Page Four', 'Page Three', 'Page Two', 'Page One'])
      conjure(ctx, 'P1', LAB_CARD(name), 'library');
    return ctx;
  }

  /** Cast Watcher, resolve it and its Hideaway trigger (exiling the first offered card). */
  function castWatcher(ctx: GameContext) {
    const card = castFromHand(ctx, 'P1', watcher.card, [...generic(1), ...blue(1)]);
    resolveTop(ctx);
    settle(ctx);
    return onField(ctx, card.cardId)!;
  }

  it('watcher-for-tomorrow-pinned-oracle-supported — the interpreter alone models Hideaway, entering tapped and the leaves trigger', () => {
    expect(watcher.sha256).toBe('02360583993a6941a09046d20aefacec8e53d3acaa1cc092eee1f67eff3f2e57');
    expectNoRegistration(watcher.card);
    expectModeled(watcher.card);
    const def = interpretCard(watcher.card);
    expect(def.entersTapped).toBe(true);
    expect(def.triggers.map((trigger) => trigger.trigger?.when)).toEqual([
      'enters',
      'leavesBattlefield',
    ]);
    expect(def.triggers[1]!.effects).toEqual([{ op: 'returnExiledAttachedCard' }]);
  });

  it('watcher-for-tomorrow-hideaway-then-dies — it enters tapped, hides a card, and dying puts that card into your hand', () => {
    const ctx = ready('watcher-dies');
    const perm = castWatcher(ctx);
    expect(perm.tapped).toBe(true);
    expect(ctx.state.exile).toHaveLength(1);
    const hidden = ctx.state.exile[0]!;
    expect(playerById(ctx, 'P1').library).toHaveLength(3);
    kill(ctx, perm);
    settle(ctx);
    expect(playerById(ctx, 'P1').hand.map((card) => card.cardId)).toEqual([hidden.cardId]);
    expect(ctx.state.exile).toEqual([]);
  });

  it('watcher-for-tomorrow-leaves-any-way — bounced or exiled, not only dying, it returns the hidden card', () => {
    for (const zone of ['hand', 'exile'] as const) {
      const ctx = ready(`watcher-${zone}`);
      const perm = castWatcher(ctx);
      const hidden = ctx.state.exile[0]!;
      pump(moveObject(ctx, perm, { zone }));
      expect(
        ctx.state.pendingTriggers.map((trigger) => trigger.sourceName),
        zone,
      ).toEqual(['Watcher for Tomorrow']);
      settle(ctx);
      expect(
        playerById(ctx, 'P1').hand.map((card) => card.cardId),
        zone,
      ).toContain(hidden.cardId);
    }
  });

  it('watcher-for-tomorrow-linked-card-only — a card hidden by an earlier incarnation is not returned', () => {
    const ctx = ready('watcher-linked');
    const perm = spawn(ctx, 'P1', watcher.card);
    const stale = conjure(ctx, 'P1', LAB_CARD('Old Secret'), 'exile');
    stale.attachedToCardId = perm.cardId;
    stale.attachedToObjectId = 'an-earlier-incarnation';
    kill(ctx, perm);
    settle(ctx);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Old Secret']);
    expect(playerById(ctx, 'P1').hand).toEqual([]);
  });

  it('leaves-battlefield-primitive-destinations — the event fires for every destination and a leavesTo head narrows it', () => {
    const listener = oracle({
      name: 'Lab Exile Watcher',
      typeLine: 'Creature — Spirit',
      oracleText:
        'Whenever another creature you control is put into a graveyard from the battlefield or is put into exile from the battlefield, draw a card.',
    });
    const bear = oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear' });
    const ctx = pod('leaves-destinations');
    spawn(ctx, 'P1', listener);
    for (const zone of ['graveyard', 'exile', 'hand', 'library'] as const) {
      ctx.state.pendingTriggers = [];
      pump(moveObject(ctx, spawn(ctx, 'P1', bear), { zone }));
      expect(ctx.state.pendingTriggers.length, zone).toBe(
        zone === 'graveyard' || zone === 'exile' ? 1 : 0,
      );
    }
    ctx.state.pendingTriggers = [];
    pump(movePermanentsToGraveyard(ctx, [spawn(ctx, 'P1', bear), spawn(ctx, 'P1', bear)]));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    const issues: AuthoringIssue[] = [];
    validateTriggerHead(
      { when: 'dies', subject: { kind: 'self' }, leavesTo: ['exile'] },
      'trigger',
      issues,
    );
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.leavesTo']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.06 Psychomancer
// ---------------------------------------------------------------------------------------------

describe('Psychomancer', () => {
  const psycho = pinned('Psychomancer');
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });

  const aimAt =
    (player: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, player]]) };
      return { index: 0, targets: new Map() };
    };

  it('psychomancer-pinned-oracle-supported — the interpreter alone models flying and the graveyard-or-exile drain', () => {
    expect(psycho.sha256).toBe('a9688ee818cfe44f6d23dd346d4e998a40205b0c24397080ecd37f21f26c481c');
    expectNoRegistration(psycho.card);
    expectModeled(psycho.card);
    const def = interpretCard(psycho.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]!.trigger).toMatchObject({
      when: 'leavesBattlefield',
      leavesTo: ['graveyard', 'exile'],
    });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
  });

  it('psychomancer-dies-drains — dying, it drains target opponent for 1', () => {
    const ctx = pod('psycho-dies');
    const perm = spawn(ctx, 'P1', psycho.card);
    kill(ctx, perm);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(39);
    expect(playerById(ctx, 'P1').life).toBe(41);
  });

  it('psychomancer-artifact-graveyard-or-exile — another nontoken artifact you control destroyed or exiled drains', () => {
    for (const zone of ['graveyard', 'exile'] as const) {
      const ctx = pod(`psycho-${zone}`);
      spawn(ctx, 'P1', psycho.card);
      pump(moveObject(ctx, spawn(ctx, 'P1', relic), { zone }));
      settle(ctx, aimAt('P3'));
      expect(playerById(ctx, 'P3').life, zone).toBe(39);
      expect(playerById(ctx, 'P1').life, zone).toBe(41);
    }
  });

  it('psychomancer-not-other-departures — a bounce, a token, or an opponent’s artifact drains nothing', () => {
    const ctx = pod('psycho-negative');
    spawn(ctx, 'P1', psycho.card);
    pump(moveObject(ctx, spawn(ctx, 'P1', relic), { zone: 'hand' }));
    kill(ctx, spawn(ctx, 'P1', relic, { isToken: true }));
    kill(ctx, spawn(ctx, 'P2', relic));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('psychomancer-dies-together — dying with an artifact you control, it sees both (last-known information)', () => {
    const ctx = pod('psycho-together');
    const perm = spawn(ctx, 'P1', psycho.card);
    const other = spawn(ctx, 'P1', relic);
    pump(movePermanentsToGraveyard(ctx, [perm, other]));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Psychomancer',
      'Psychomancer',
    ]);
    settle(ctx, aimAt('P2'));
    expect(playerById(ctx, 'P2').life).toBe(38);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.19 Shard of the Void Dragon
// ---------------------------------------------------------------------------------------------

describe('Shard of the Void Dragon', () => {
  const shard = pinned('Shard of the Void Dragon');
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const grove = oracle({ name: 'Lab Grove', typeLine: 'Land' });

  it('shard-of-the-void-dragon-pinned-oracle-supported — the interpreter alone models flying, the attack edict and Matter Absorption', () => {
    expect(shard.sha256).toBe('fd95a3c55790914954c24c7f1db5acb38bf6d3721993864206f3541446b7f389');
    expectNoRegistration(shard.card);
    expectModeled(shard.card);
    const def = interpretCard(shard.card);
    expect(def.keywords).toEqual(['flying']);
    expect(def.triggers.map((trigger) => trigger.effects)).toEqual([
      [{ op: 'sacrificeOneEachOpponent', filter: 'nonland' }],
      [{ op: 'putCountersEach', selector: { kind: 'self' }, counter: '+1/+1', count: 2 }],
    ]);
    expect(def.triggers[1]!.trigger).toEqual({
      when: 'leavesBattlefield',
      subject: { kind: 'permanent', selector: { kind: 'type', value: 'Artifact' } },
      leavesTo: ['graveyard', 'exile'],
    });
  });

  it('shard-of-the-void-dragon-attack-edict — attacking, each opponent sacrifices a nonland permanent; a sacrificed artifact grows it', () => {
    const ctx = pod('void-attack');
    const self = spawn(ctx, 'P1', shard.card);
    spawn(ctx, 'P2', relic);
    spawn(ctx, 'P2', grove);
    spawn(ctx, 'P3', bear);
    spawn(ctx, 'P4', grove);
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        return declareAttacks(decision, (subjectId) => (subjectId === self.id ? 'P2' : null));
      }
      if (decision.presentationBlockDeclaration !== undefined) {
        return { index: 0, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(ctx.state.battlefield.map((perm) => `${perm.controllerId}:${perm.name}`).sort()).toEqual(
      ['P1:Shard of the Void Dragon', 'P2:Lab Grove', 'P4:Lab Grove'],
    );
    expect(onField(ctx, self.cardId)?.counters).toEqual({ '+1/+1': 2 });
    expect(playerById(ctx, 'P2').life).toBe(40 - 9);
  });

  it('shard-of-the-void-dragon-any-artifact — any artifact destroyed or exiled, even a token, adds two counters; a bounce does not', () => {
    const ctx = pod('void-artifacts');
    const self = spawn(ctx, 'P1', shard.card);
    kill(ctx, spawn(ctx, 'P3', relic));
    pump(moveObject(ctx, spawn(ctx, 'P1', relic), { zone: 'exile' }));
    kill(ctx, spawn(ctx, 'P2', relic, { isToken: true }));
    pump(moveObject(ctx, spawn(ctx, 'P2', relic), { zone: 'hand' }));
    kill(ctx, spawn(ctx, 'P2', bear));
    settle(ctx);
    expect(onField(ctx, self.cardId)?.counters).toEqual({ '+1/+1': 6 });
  });
});

// ---------------------------------------------------------------------------------------------
// 3.08 Scavenging Ooze
// ---------------------------------------------------------------------------------------------

describe('Scavenging Ooze', () => {
  const ooze = pinned('Scavenging Ooze');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });

  /** Activate the Ooze with {G}, targeting `cardId`, and leave the ability on the stack. */
  function activate(ctx: GameContext, perm: EnginePermanent, targetId: string) {
    addMana(playerById(ctx, 'P1'), green(1));
    const option = optionFor(ctx, 'P1', perm.id, /Exile target card from a graveyard/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, targetId]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
  }

  it('scavenging-ooze-pinned-oracle-supported — the interpreter alone models the {G} graveyard exile with its creature rider', () => {
    expect(ooze.sha256).toBe('5e3b74f8d24d0bbc052267d35ec3e142201a4101036888a29689867fbf42b971');
    expectNoRegistration(ooze.card);
    expectModeled(ooze.card);
    const [ability] = interpretCard(ooze.card).activatedAbilities;
    expect(ability?.ability.targets).toEqual([
      { kind: 'cardInGraveyard', graveyardOwnerScope: 'any' },
    ]);
    expect(ability?.ability.effects).toEqual([
      { op: 'exileTargetGraveyardAndBuffIfCreature', targetSlot: 0 },
    ]);
  });

  it('scavenging-ooze-creature-card — exiling a creature card from any graveyard grows it and gains 1 life', () => {
    const ctx = pod('ooze-creature');
    const perm = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    activate(ctx, perm, target.id);
    resolveTop(ctx);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
    expect(perm.counters).toEqual({ '+1/+1': 1 });
    expect(playerById(ctx, 'P1').life).toBe(41);
  });

  it('scavenging-ooze-noncreature-card — a noncreature card is exiled with no counter and no life', () => {
    const ctx = pod('ooze-noncreature');
    const perm = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P2', relic, 'graveyard');
    activate(ctx, perm, target.id);
    resolveTop(ctx);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Relic']);
    expect(perm.counters).toEqual({});
    expect(playerById(ctx, 'P1').life).toBe(40);
  });

  it('scavenging-ooze-leaves-graveyard-event — the exile is a real zone change that leave-graveyard abilities see', () => {
    const ctx = pod('ooze-zone-change');
    const perm = spawn(ctx, 'P1', ooze.card);
    const watcherCard = oracle({ name: 'Lab Grave Listener', typeLine: 'Enchantment' });
    const watcherDef = interpretCard(watcherCard);
    registerCustomDef(ctx, {
      ...watcherDef,
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'leavesGraveyard',
            subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
          },
          targets: [],
          effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
          description: 'Whenever a creature card leaves a graveyard, draw a card',
        },
      ],
    });
    spawn(ctx, 'P2', watcherCard);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    activate(ctx, perm, target.id);
    resolveTop(ctx);
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Lab Grave Listener',
    ]);
  });

  it('scavenging-ooze-target-gone — a target that left the graveyard first leaves nothing to exile and no life', () => {
    const ctx = pod('ooze-gone');
    const perm = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    activate(ctx, perm, target.id);
    pump(moveObject(ctx, playerById(ctx, 'P3').graveyard[0]!, { zone: 'hand' }));
    resolveTop(ctx);
    expect(perm.counters).toEqual({});
    expect(playerById(ctx, 'P1').life).toBe(40);
  });

  it('scavenging-ooze-source-gone — with the Ooze gone, a creature card is still exiled and you still gain 1 life', () => {
    const ctx = pod('ooze-source-gone');
    const perm = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    activate(ctx, perm, target.id);
    kill(ctx, perm);
    resolveTop(ctx);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
    expect(playerById(ctx, 'P1').life).toBe(41);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.17 Imotekh the Stormlord
// ---------------------------------------------------------------------------------------------

describe('Imotekh the Stormlord', () => {
  const imotekh = pinned('Imotekh the Stormlord');
  const construct = oracle({
    name: 'Lab Construct',
    typeLine: 'Artifact Creature — Construct',
    power: '1',
    toughness: '1',
  });
  const relic = oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{2}' });
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const warriors = (ctx: GameContext, controllerId = 'P1') =>
    ctx.state.battlefield.filter(
      (perm) =>
        perm.isToken && perm.name === 'Necron Warrior' && perm.controllerId === controllerId,
    );

  /** Run P1's combat with no attackers, so begin-combat triggers resolve. */
  function beginCombat(ctx: GameContext, answer?: Answer) {
    pump(runCombatAndExtraCombats(ctx), (decision, count) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    });
  }

  it('imotekh-the-stormlord-pinned-oracle-supported — the interpreter alone models Phaeron and Grand Strategist', () => {
    expect(imotekh.sha256).toBe('389742a3862725250d3388b5fa5f0200082ca1cf88295b1f2472ff1e31a9c14c');
    expectNoRegistration(imotekh.card);
    expectModeled(imotekh.card);
    const def = interpretCard(imotekh.card);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'leavesGraveyard',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Artifact' },
            { kind: 'controller', who: 'you' },
          ],
        },
      },
      aggregate: true,
    });
    expect(def.triggers[1]!.trigger).toEqual({ when: 'beginningOfCombat', player: 'you' });
    expect(def.triggers[1]!.targets).toEqual([
      {
        kind: 'creature',
        filter: { kind: 'allOf', of: [{ kind: 'other' }, { kind: 'type', value: 'Artifact' }] },
        controller: 'you',
      },
    ]);
  });

  it('imotekh-the-stormlord-phaeron-reanimate — an artifact card leaving your graveyard makes two 2/2 Necron Warriors', () => {
    const ctx = pod('imotekh-reanimate');
    spawn(ctx, 'P1', imotekh.card);
    enterFrom(ctx, 'P1', construct, 'graveyard');
    settle(ctx);
    expect(warriors(ctx)).toHaveLength(2);
    const chars = computeCharacteristics(ctx, warriors(ctx)[0]!);
    expect(chars.types).toEqual(['Artifact', 'Creature']);
    expect(chars.colors).toEqual(['B']);
    expect([chars.power, chars.toughness]).toEqual([2, 2]);
  });

  it('imotekh-the-stormlord-phaeron-one-or-more — several artifact cards leaving together trigger once', () => {
    const ctx = pod('imotekh-batch');
    spawn(ctx, 'P1', imotekh.card);
    const cards = [conjure(ctx, 'P1', relic, 'graveyard'), conjure(ctx, 'P1', relic, 'graveyard')];
    pump(moveObjects(ctx, cards, { zone: 'exile' }));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    settle(ctx);
    expect(warriors(ctx)).toHaveLength(2);
  });

  it("imotekh-the-stormlord-phaeron-negative — a nonartifact card or another player's artifact card does nothing", () => {
    const ctx = pod('imotekh-negative');
    spawn(ctx, 'P1', imotekh.card);
    pump(moveObject(ctx, conjure(ctx, 'P1', bear, 'graveyard'), { zone: 'exile' }));
    pump(moveObject(ctx, conjure(ctx, 'P2', relic, 'graveyard'), { zone: 'exile' }));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('imotekh-the-stormlord-grand-strategist — at your combat, another artifact creature you control gets +2/+2 and menace', () => {
    const ctx = pod('imotekh-combat');
    const self = spawn(ctx, 'P1', imotekh.card);
    const ally = spawn(ctx, 'P1', construct);
    const bearPerm = spawn(ctx, 'P1', bear);
    const theirs = spawn(ctx, 'P2', construct);
    const offered: string[] = [];
    beginCombat(ctx, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) {
        offered.push(...slot.options);
        return { index: 0, targets: new Map([[slot.slot, ally.id]]) };
      }
      return { index: 0, targets: new Map() };
    });
    // The only legal target (not Imotekh, the Bear, or P2's Construct) is chosen automatically.
    expect(offered.every((id) => id === ally.id)).toBe(true);
    expect(effectivePT(ctx, bearPerm)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, theirs)).toEqual({ power: 1, toughness: 1 });
    expect(computeCharacteristics(ctx, theirs).keywords).not.toContain('menace');
    expect(effectivePT(ctx, ally)).toEqual({ power: 3, toughness: 3 });
    expect(computeCharacteristics(ctx, ally).keywords).toContain('menace');
    expect(effectivePT(ctx, self)).toEqual({ power: 3, toughness: 3 });
  });

  it('imotekh-the-stormlord-grand-strategist-needs-another — alone, Imotekh has no legal target and is not pumped', () => {
    const ctx = pod('imotekh-alone');
    const self = spawn(ctx, 'P1', imotekh.card);
    spawn(ctx, 'P1', bear);
    beginCombat(ctx);
    expect(effectivePT(ctx, self)).toEqual({ power: 3, toughness: 3 });
    expect(computeCharacteristics(ctx, self).keywords).not.toContain('menace');
  });
});

// ---------------------------------------------------------------------------------------------
// 3.20 The Ooze
// ---------------------------------------------------------------------------------------------

const THE_OOZE_SHA = 'b62bfacc5e4d0b4478a1a3f5f84b9e78cdc6f381d6ad8ce42fa9b7da74521387';

describe('The Ooze', () => {
  const ooze = pinned('The Ooze');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const mutagens = (ctx: GameContext, controllerId = 'P1') =>
    ctx.state.battlefield.filter(
      (perm) => perm.isToken && perm.name === 'Mutagen' && perm.controllerId === controllerId,
    );
  function withCounters(perm: EnginePermanent, counters: Record<string, number>) {
    perm.counters = { ...counters };
    return perm;
  }

  it('the-ooze-pinned-oracle-supported — the interpreter alone models the leave trigger, the exile, and the Mutagen token', () => {
    expect(ooze.sha256).toBe(THE_OOZE_SHA);
    expectNoRegistration(ooze.card);
    expectModeled(ooze.card);
    const def = interpretCard(ooze.card);
    expect(def.triggers[0]!.trigger).toEqual({
      when: 'leavesBattlefield',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'hasCounter', counter: '+1/+1' },
            { kind: 'controller', who: 'you' },
            { kind: 'type', value: 'Creature' },
          ],
        },
      },
    });
    expect(def.triggers[0]!.effects).toEqual([
      {
        op: 'createToken',
        spec: MUTAGEN,
        count: { kind: 'countersOnTriggerObject', counter: '+1/+1' },
      },
    ]);
    const [exile] = def.activatedAbilities;
    expect(exile?.costs).toEqual([{ kind: 'tap' }]);
    expect(exile?.ability.targets).toEqual([
      { kind: 'cardInGraveyard', graveyardOwnerScope: 'any' },
    ]);
    expect(exile?.ability.effects).toEqual([
      { op: 'exileCard', target: 0 },
      { op: 'createToken', spec: MUTAGEN, count: { kind: 'const', n: 1 } },
    ]);
  });

  it('the-ooze-dies-counts-last-known-counters — a creature dying with two +1/+1 counters makes two Mutagens', () => {
    const ctx = pod('the-ooze-dies');
    spawn(ctx, 'P1', ooze.card);
    const creature = withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 2 });
    kill(ctx, creature);
    settle(ctx);
    expect(mutagens(ctx)).toHaveLength(2);
  });

  it('the-ooze-leaves-not-only-dies — exile and a return to hand also trigger', () => {
    const ctx = pod('the-ooze-exile');
    spawn(ctx, 'P1', ooze.card);
    const exiled = withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 1 });
    const bounced = withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 3 });
    pump(moveObject(ctx, exiled, { zone: 'exile' }));
    pump(moveObject(ctx, bounced, { zone: 'hand' }));
    settle(ctx);
    expect(mutagens(ctx)).toHaveLength(4);
  });

  it("the-ooze-negative — no +1/+1 counter, only a -1/-1 counter, or an opponent's creature does nothing", () => {
    const ctx = pod('the-ooze-negative');
    spawn(ctx, 'P1', ooze.card);
    kill(ctx, spawn(ctx, 'P1', bear));
    kill(ctx, withCounters(spawn(ctx, 'P1', bear), { '-1/-1': 1 }));
    kill(ctx, withCounters(spawn(ctx, 'P2', bear), { '+1/+1': 2 }));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('the-ooze-leaves-alongside — leaving at the same time as the creature still triggers (CR 603.10a)', () => {
    const ctx = pod('the-ooze-together');
    const self = spawn(ctx, 'P1', ooze.card);
    const creature = withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 2 });
    pump(moveObjects(ctx, [self, creature], { zone: 'exile' }));
    settle(ctx);
    expect(mutagens(ctx)).toHaveLength(2);
  });

  it('the-ooze-mass-exile — "exile all nonland permanents" takes The Ooze with the creatures, and it still triggers for each', () => {
    const ctx = pod('the-ooze-mass-exile');
    spawn(ctx, 'P1', ooze.card);
    withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 1 });
    withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 2 });
    const sweep = oracle({
      name: 'Lab Exile Sweep',
      typeLine: 'Sorcery',
      manaCost: '{G}',
      oracleText: 'Exile all nonland permanents.',
    });
    castFromHand(ctx, 'P1', sweep, green(1));
    resolveTop(ctx);
    expect(ctx.state.battlefield.filter((perm) => perm.name !== 'Forest')).toEqual([]);
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    settle(ctx);
    expect(mutagens(ctx)).toHaveLength(3);
  });

  it('the-ooze-mass-bounce — "return all nonland permanents" to hand is one departure too', () => {
    const ctx = pod('the-ooze-mass-bounce');
    spawn(ctx, 'P1', ooze.card);
    withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 2 });
    const wave = oracle({
      name: 'Lab Bounce Wave',
      typeLine: 'Sorcery',
      manaCost: '{G}',
      oracleText: "Return all nonland permanents to their owners' hands.",
    });
    castFromHand(ctx, 'P1', wave, green(1));
    resolveTop(ctx);
    expect(
      playerById(ctx, 'P1')
        .hand.map((card) => card.name)
        .sort(),
    ).toEqual(['Lab Bear', 'The Ooze']);
    settle(ctx);
    expect(mutagens(ctx)).toHaveLength(2);
  });

  it('the-ooze-exile-makes-a-mutagen — {T} exiles a card from any graveyard and makes a Mutagen', () => {
    const ctx = pod('the-ooze-tap');
    const self = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    const option = optionFor(ctx, 'P1', self.id, /Exile target card from a graveyard/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    expect(self.tapped).toBe(true);
    resolveTop(ctx);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
    expect(mutagens(ctx)).toHaveLength(1);
  });

  it('the-ooze-exile-target-gone — with its only target gone the ability does nothing, so no Mutagen', () => {
    const ctx = pod('the-ooze-tap-gone');
    const self = spawn(ctx, 'P1', ooze.card);
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    const option = optionFor(ctx, 'P1', self.id, /Exile target card from a graveyard/);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    pump(moveObject(ctx, playerById(ctx, 'P3').graveyard[0]!, { zone: 'hand' }));
    resolveTop(ctx);
    expect(ctx.state.exile).toEqual([]);
    expect(mutagens(ctx)).toEqual([]);
  });

  it('the-ooze-mutagen-token — {1}, {T}, sacrifice the Mutagen at sorcery speed for a +1/+1 counter', () => {
    const ctx = pod('the-ooze-mutagen');
    spawn(ctx, 'P1', ooze.card);
    const creature = spawn(ctx, 'P1', bear);
    kill(ctx, withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 1 }));
    settle(ctx);
    const [token] = mutagens(ctx);
    expect(token).toBeDefined();
    addMana(playerById(ctx, 'P1'), green(1));
    const option = optionFor(ctx, 'P1', token!.id, /Put a \+1\/\+1 counter on target creature/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, creature.id]]),
    );
    expect(mutagens(ctx)).toEqual([]);
    resolveTop(ctx);
    expect(creature.counters).toEqual({ '+1/+1': 1 });
  });

  it('the-ooze-mutagen-sorcery-speed — the Mutagen cannot be activated with a spell on the stack', () => {
    const ctx = pod('the-ooze-mutagen-timing');
    spawn(ctx, 'P1', ooze.card);
    const self = ctx.state.battlefield.find((perm) => perm.name === 'The Ooze')!;
    kill(ctx, withCounters(spawn(ctx, 'P1', bear), { '+1/+1': 1 }));
    settle(ctx);
    const [token] = mutagens(ctx);
    addMana(playerById(ctx, 'P1'), green(1));
    const target = conjure(ctx, 'P3', bear, 'graveyard');
    const exile = optionFor(ctx, 'P1', self.id, /Exile target card from a graveyard/);
    takeAction(
      ctx,
      'P1',
      exile!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(optionFor(ctx, 'P1', token!.id, /Put a \+1\/\+1 counter/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 3.24 Candlekeep Sage
// ---------------------------------------------------------------------------------------------

const CANDLEKEEP_SAGE_SHA = '0ed0ff30dcf72ddcda8b2faa9628978ea65b1f7de653a344e84259b1890f052e';

describe('Candlekeep Sage', () => {
  const sage = pinned('Candlekeep Sage');
  const general = oracle({
    name: 'Lab General',
    typeLine: 'Legendary Creature — Human',
    power: '3',
    toughness: '3',
  });
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const handSize = (ctx: GameContext, playerId: string) => playerById(ctx, playerId).hand.length;

  it('candlekeep-sage-pinned-oracle-supported — the interpreter grants commander creatures you own an enters-or-leaves draw', () => {
    expect(sage.sha256).toBe(CANDLEKEEP_SAGE_SHA);
    expectNoRegistration(sage.card);
    expectModeled(sage.card);
    const def = interpretCard(sage.card);
    const affects = {
      kind: 'allOf',
      of: [
        { kind: 'isCommander' },
        { kind: 'type', value: 'Creature' },
        { kind: 'owner', who: 'you' },
      ],
    };
    expect(def.staticEffects.map((effect) => effect.affects)).toEqual([affects, affects]);
    expect(
      def.staticEffects.map((effect) => {
        const op = effect.op as { addTrigger?: { trigger: unknown; effects: unknown } };
        return [op.addTrigger?.trigger, op.addTrigger?.effects];
      }),
    ).toEqual([
      [
        { when: 'enters', subject: { kind: 'self' } },
        [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      ],
      [
        { when: 'leavesBattlefield', subject: { kind: 'self' } },
        [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      ],
    ]);
  });

  it('candlekeep-sage-commander-enters — your commander entering draws a card', () => {
    const ctx = pod('sage-enters');
    spawn(ctx, 'P1', sage.card);
    const before = handSize(ctx, 'P1');
    const commander = conjure(ctx, 'P1', general, 'command', { isCommander: true });
    pump(moveObject(ctx, commander, { zone: 'battlefield', controllerId: 'P1' }));
    settle(ctx);
    expect(handSize(ctx, 'P1')).toBe(before + 1);
  });

  it('candlekeep-sage-commander-leaves — your commander dying or being exiled draws a card', () => {
    const ctx = pod('sage-leaves');
    spawn(ctx, 'P1', sage.card);
    const dying = spawn(ctx, 'P1', general, { isCommander: true });
    const exiled = spawn(ctx, 'P1', general, { isCommander: true });
    const before = handSize(ctx, 'P1');
    kill(ctx, dying);
    pump(moveObject(ctx, exiled, { zone: 'exile' }));
    settle(ctx);
    expect(handSize(ctx, 'P1')).toBe(before + 2);
  });

  it("candlekeep-sage-negative — a noncommander creature, or another player's commander, draws nothing", () => {
    const ctx = pod('sage-negative');
    spawn(ctx, 'P1', sage.card);
    kill(ctx, spawn(ctx, 'P1', bear));
    kill(ctx, spawn(ctx, 'P2', general, { isCommander: true }));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('candlekeep-sage-ownership-not-control — your commander an opponent controls draws for them; theirs you control does not', () => {
    const ctx = pod('sage-ownership');
    spawn(ctx, 'P1', sage.card);
    const yoursStolen = spawn(ctx, 'P1', general, { isCommander: true });
    yoursStolen.controllerId = 'P2';
    const theirsBorrowed = spawn(ctx, 'P2', general, { isCommander: true });
    theirsBorrowed.controllerId = 'P1';
    const p1 = handSize(ctx, 'P1');
    const p2 = handSize(ctx, 'P2');
    pump(moveObject(ctx, yoursStolen, { zone: 'exile' }));
    pump(moveObject(ctx, theirsBorrowed, { zone: 'exile' }));
    settle(ctx);
    expect(handSize(ctx, 'P2')).toBe(p2 + 1);
    expect(handSize(ctx, 'P1')).toBe(p1);
  });

  it('candlekeep-sage-leaves-together — the Sage leaving with your commander still grants the leave draw (CR 603.10a)', () => {
    const ctx = pod('sage-together');
    const self = spawn(ctx, 'P1', sage.card);
    const commander = spawn(ctx, 'P1', general, { isCommander: true });
    const before = handSize(ctx, 'P1');
    pump(moveObjects(ctx, [self, commander], { zone: 'exile' }));
    settle(ctx);
    expect(handSize(ctx, 'P1')).toBe(before + 1);
  });

  it('candlekeep-sage-bounced-to-command-zone — a mass bounce redirected to the command zone draws once', () => {
    const wave = oracle({
      name: 'Lab Bounce Wave',
      typeLine: 'Sorcery',
      manaCost: '{G}',
      oracleText: "Return all nonland permanents to their owners' hands.",
    });
    for (const choice of [/^Put /, /^Let /]) {
      const ctx = pod('sage-bounce');
      // The commander moves first, while the Sage is still on the battlefield.
      spawn(ctx, 'P1', general, { isCommander: true });
      spawn(ctx, 'P1', sage.card);
      castFromHand(ctx, 'P1', wave, green(1));
      const before = handSize(ctx, 'P1');
      resolveTop(ctx, answers([[/command zone instead/, choice]]));
      // One leave trigger for the commander, whichever zone the owner picks.
      expect(ctx.state.pendingTriggers.map((trigger) => trigger.ability.description)).toEqual([
        'When this creature enters or leaves the battlefield, draw a card',
      ]);
      settle(ctx);
      // The Sage returns to hand, plus one draw, plus the commander if it was kept in hand.
      expect(handSize(ctx, 'P1')).toBe(before + (choice.source === '^Put ' ? 2 : 3));
    }
  });

  it('candlekeep-sage-gone — with the Sage gone, your commander leaving draws nothing', () => {
    const ctx = pod('sage-gone');
    const self = spawn(ctx, 'P1', sage.card);
    const commander = spawn(ctx, 'P1', general, { isCommander: true });
    pump(moveObject(ctx, self, { zone: 'exile' }));
    pump(moveObject(ctx, commander, { zone: 'exile' }));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.27 God-Eternal Rhonas
// ---------------------------------------------------------------------------------------------

describe('God-Eternal Rhonas', () => {
  const rhonas = pinned('God-Eternal Rhonas');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const ox = oracle({ name: 'Lab Ox', typeLine: 'Creature — Ox', power: '3', toughness: '5' });
  const libraryCard = oracle({ name: 'Lab Library Card', typeLine: 'Artifact', manaCost: '{1}' });
  const yes = answers([[/use this ability/, /^Yes$/]]);
  const no = answers([[/use this ability/, /^No$/]]);

  /** P1's library is exactly `n` known cards. */
  function stackLibrary(ctx: GameContext, n: number) {
    playerById(ctx, 'P1').library.length = 0;
    for (let i = 0; i < n; i++) conjure(ctx, 'P1', libraryCard, 'library');
  }
  const libraryNames = (ctx: GameContext) => playerById(ctx, 'P1').library.map((card) => card.name);

  it('god-eternal-rhonas-pinned-oracle-supported — the interpreter models deathtouch, the doubling, and the library return', () => {
    expect(rhonas.sha256).toBe('9df5c8f3e19a33b551697b160048537779dba35bd4d3e445302bd8e861ed57e6');
    expectNoRegistration(rhonas.card);
    expectModeled(rhonas.card);
    const def = interpretCard(rhonas.card);
    expect(def.keywords).toContain('deathtouch');
    const others = {
      kind: 'allOf',
      of: [
        { kind: 'other' },
        { kind: 'type', value: 'Creature' },
        { kind: 'controller', who: 'you' },
      ],
    };
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'doublePower', selector: others },
      { op: 'grantKeywordEachUntilEot', selector: others, keyword: 'vigilance' },
    ]);
    expect(def.triggers[1]!.trigger).toEqual({
      when: 'leavesBattlefield',
      subject: { kind: 'self' },
      leavesTo: ['graveyard', 'exile'],
    });
    expect(def.triggers[1]!.optional).toBe(true);
    expect(def.triggers[1]!.effects).toEqual([{ op: 'putDepartedSourceIntoLibrary', fromTop: 3 }]);
  });

  it('god-eternal-rhonas-enters-doubles-others — each other creature you control has its power doubled and gains vigilance', () => {
    const ctx = pod('rhonas-enters');
    const mine = spawn(ctx, 'P1', bear);
    const big = spawn(ctx, 'P1', ox);
    const theirs = spawn(ctx, 'P2', bear);
    const self = enterFrom(ctx, 'P1', rhonas.card, 'hand');
    settle(ctx);
    expect(effectivePT(ctx, mine)).toEqual({ power: 4, toughness: 2 });
    expect(effectivePT(ctx, big)).toEqual({ power: 6, toughness: 5 });
    expect(computeCharacteristics(ctx, mine).keywords).toContain('vigilance');
    expect(effectivePT(ctx, theirs)).toEqual({ power: 2, toughness: 2 });
    expect(computeCharacteristics(ctx, theirs).keywords).not.toContain('vigilance');
    expect(effectivePT(ctx, self)).toEqual({ power: 5, toughness: 5 });
    expect(computeCharacteristics(ctx, self).keywords).not.toContain('vigilance');
  });

  it('god-eternal-rhonas-dies-third-from-top — dying, it may go into its library third from the top', () => {
    const ctx = pod('rhonas-dies');
    stackLibrary(ctx, 4);
    kill(ctx, spawn(ctx, 'P1', rhonas.card));
    settle(ctx, yes);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
    expect(libraryNames(ctx)).toEqual([
      'Lab Library Card',
      'Lab Library Card',
      'God-Eternal Rhonas',
      'Lab Library Card',
      'Lab Library Card',
    ]);
  });

  it('god-eternal-rhonas-exiled-third-from-top — exiled from the battlefield, it may go into its library too', () => {
    const ctx = pod('rhonas-exiled');
    stackLibrary(ctx, 3);
    pump(moveObject(ctx, spawn(ctx, 'P1', rhonas.card), { zone: 'exile' }));
    settle(ctx, yes);
    expect(ctx.state.exile).toEqual([]);
    expect(libraryNames(ctx)[2]).toBe('God-Eternal Rhonas');
  });

  it('god-eternal-rhonas-decline — declining leaves it in the graveyard', () => {
    const ctx = pod('rhonas-decline');
    stackLibrary(ctx, 3);
    kill(ctx, spawn(ctx, 'P1', rhonas.card));
    settle(ctx, no);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'God-Eternal Rhonas',
    ]);
    expect(libraryNames(ctx)).not.toContain('God-Eternal Rhonas');
  });

  it('god-eternal-rhonas-bounce-no-trigger — returning to hand is neither dying nor exile', () => {
    const ctx = pod('rhonas-bounce');
    pump(moveObject(ctx, spawn(ctx, 'P1', rhonas.card), { zone: 'hand' }));
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('god-eternal-rhonas-card-moved-on — if the card left the graveyard first, nothing moves (CR 400.7)', () => {
    const ctx = pod('rhonas-moved-on');
    stackLibrary(ctx, 3);
    kill(ctx, spawn(ctx, 'P1', rhonas.card));
    pump(moveObject(ctx, playerById(ctx, 'P1').graveyard[0]!, { zone: 'exile' }));
    settle(ctx, yes);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['God-Eternal Rhonas']);
    expect(libraryNames(ctx)).not.toContain('God-Eternal Rhonas');
  });

  it('god-eternal-rhonas-short-library — with fewer than two cards above, it goes on the bottom (CR 401.7)', () => {
    const ctx = pod('rhonas-short');
    stackLibrary(ctx, 1);
    kill(ctx, spawn(ctx, 'P1', rhonas.card));
    settle(ctx, yes);
    expect(libraryNames(ctx)).toEqual(['Lab Library Card', 'God-Eternal Rhonas']);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.25 Flickerwisp
// ---------------------------------------------------------------------------------------------

const FLICKERWISP_SHA = '2c5047d9ba2f69bc11fae70409c7de721dce424a456f595cdd7c9705b7830404';

describe('Flickerwisp', () => {
  const wisp = pinned('Flickerwisp');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const aim =
    (id: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, id]]) };
      return { index: 0, targets: new Map() };
    };
  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);

  it('flickerwisp-pinned-oracle-supported — the interpreter models flying and the exile with a next-end-step return', () => {
    expect(wisp.sha256).toBe(FLICKERWISP_SHA);
    expectNoRegistration(wisp.card);
    expectModeled(wisp.card);
    const def = interpretCard(wisp.card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers[0]!.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'permanent', filter: { kind: 'other' } }]);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'exileTargetReturnAtNextEndStep', target: 0, returnUnder: 'owner' },
    ]);
  });

  it("flickerwisp-returns-at-next-end-step — an opponent's creature is exiled, then returns under its owner's control as a new object", () => {
    const ctx = pod('wisp-return');
    const theirs = spawn(ctx, 'P2', bear);
    enterFrom(ctx, 'P1', wisp.card, 'hand');
    settle(ctx, aim(theirs.id));
    expect(named(ctx, 'Lab Bear')).toEqual([]);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
    beginEndStep(ctx);
    settle(ctx);
    const [back] = named(ctx, 'Lab Bear');
    expect(back?.controllerId).toBe('P2');
    expect(back?.id).not.toBe(theirs.id);
    expect(ctx.state.exile).toEqual([]);
  });

  it("flickerwisp-owner-not-controller — a creature you stole returns under its owner's control", () => {
    const ctx = pod('wisp-owner');
    const stolen = spawn(ctx, 'P2', bear);
    stolen.controllerId = 'P1';
    enterFrom(ctx, 'P1', wisp.card, 'hand');
    settle(ctx, aim(stolen.id));
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab Bear')[0]?.controllerId).toBe('P2');
  });

  it('flickerwisp-token-ceases — an exiled token ceases to exist and nothing returns', () => {
    const ctx = pod('wisp-token');
    const token = spawn(ctx, 'P2', bear, { isToken: true });
    enterFrom(ctx, 'P1', wisp.card, 'hand');
    settle(ctx, aim(token.id));
    expect(ctx.state.delayedTriggers).toEqual([]);
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab Bear')).toEqual([]);
  });

  it('flickerwisp-card-left-exile — a card that left exile before the end step stays where it went (CR 400.7)', () => {
    const ctx = pod('wisp-left-exile');
    const theirs = spawn(ctx, 'P2', bear);
    enterFrom(ctx, 'P1', wisp.card, 'hand');
    settle(ctx, aim(theirs.id));
    pump(moveObject(ctx, ctx.state.exile[0]!, { zone: 'graveyard' }));
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab Bear')).toEqual([]);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Lab Bear']);
  });

  it('flickerwisp-during-end-step — exiled during an end step, it waits for the following end step', () => {
    const ctx = pod('wisp-in-end-step');
    const theirs = spawn(ctx, 'P2', bear);
    beginEndStep(ctx);
    enterFrom(ctx, 'P1', wisp.card, 'hand');
    settle(ctx, aim(theirs.id));
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
    // The next turn's end step.
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab Bear')).toHaveLength(1);
  });

  it('flickerwisp-another — it cannot target itself', () => {
    const ctx = pod('wisp-another');
    const self = enterFrom(ctx, 'P1', wisp.card, 'hand');
    expect(
      computeTargetOptions(
        ctx,
        interpretCard(wisp.card).triggers[0]!.targets[0]!,
        'P1',
        [],
        undefined,
        undefined,
        self.cardId,
      ),
    ).not.toContain(self.id);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.28 Venser, the Sojourner
// ---------------------------------------------------------------------------------------------

const VENSER_SHA = '2160ba7e8a5046951166879c01d937fbd7fdcc60d7b4a001a89876806249536b';

describe('Venser, the Sojourner', () => {
  const venser = pinned('Venser, the Sojourner');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const divination = oracle({
    name: 'Lab Divination',
    typeLine: 'Sorcery',
    manaCost: '{U}',
    oracleText: 'Draw a card.',
  });
  const aim =
    (id: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, id]]) };
      return { index: 0, targets: new Map() };
    };
  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);

  function activate(ctx: GameContext, self: EnginePermanent, cost: RegExp, targetId?: string) {
    const option = optionFor(ctx, 'P1', self.id, cost);
    expect(option, String(cost)).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      targetId === undefined ? new Map() : new Map([[0, targetId]]),
    );
    resolveTop(ctx);
  }

  /** P1's creatures attack P2; returns the attackers P2's creatures were offered to block. */
  function attackP2(ctx: GameContext): string[] {
    const offered: string[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => 'P2');
      if (decision.presentationBlockDeclaration !== undefined) {
        for (const subject of decision.presentationBlockDeclaration.subjects)
          offered.push(...subject.attackers.map((attacker) => attacker.attackerId));
        return declareBlocks(decision, () => null);
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return offered;
  }

  it('venser-the-sojourner-pinned-oracle-supported — the interpreter models all three loyalty abilities', () => {
    expect(venser.sha256).toBe(VENSER_SHA);
    expectNoRegistration(venser.card);
    expectModeled(venser.card);
    const [plus, minus, ultimate] = interpretCard(venser.card).activatedAbilities;
    expect(plus?.costs).toEqual([{ kind: 'loyalty', delta: 2 }]);
    expect(plus?.ability.targets).toEqual([
      { kind: 'permanent', filter: { kind: 'owner', who: 'you' } },
    ]);
    expect(plus?.ability.effects).toEqual([
      { op: 'exileTargetReturnAtNextEndStep', target: 0, returnUnder: 'sourceController' },
    ]);
    expect(minus?.costs).toEqual([{ kind: 'loyalty', delta: -1 }]);
    expect(minus?.ability.effects).toEqual([{ op: 'creaturesCantBeBlockedThisTurn' }]);
    expect(ultimate?.costs).toEqual([{ kind: 'loyalty', delta: -8 }]);
    const emblem = ultimate?.ability.effects[0] as Extract<Effect, { op: 'createEmblem' }>;
    expect(emblem.op).toBe('createEmblem');
    expect(
      emblem.abilities.map((ability) => [ability.trigger, ability.targets, ability.effects]),
    ).toEqual([
      [
        { when: 'castsSpell', caster: 'you' },
        [{ kind: 'permanent' }],
        [{ op: 'exile', target: 0 }],
      ],
    ]);
  });

  it('venser-plus-two-blink — +2 exiles a permanent you own and returns it under your control at the next end step', () => {
    const ctx = pod('venser-plus');
    const self = spawn(ctx, 'P1', venser.card);
    const mine = spawn(ctx, 'P1', bear);
    activate(ctx, self, /: \+2:/, mine.id);
    expect(named(ctx, 'Lab Bear')).toEqual([]);
    expect(self.counters['loyalty']).toBe(5);
    beginEndStep(ctx);
    settle(ctx);
    const [back] = named(ctx, 'Lab Bear');
    expect(back?.controllerId).toBe('P1');
    expect(back?.id).not.toBe(mine.id);
  });

  it('venser-plus-two-ownership — it targets what you own, even under an opponent, and brings it back under your control', () => {
    const ctx = pod('venser-own');
    const self = spawn(ctx, 'P1', venser.card);
    const yoursStolen = spawn(ctx, 'P1', bear);
    yoursStolen.controllerId = 'P2';
    const theirsBorrowed = spawn(ctx, 'P2', bear);
    theirsBorrowed.controllerId = 'P1';
    const spec = interpretCard(venser.card).activatedAbilities[0]!.ability.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', [], undefined, undefined, self.cardId);
    expect(legal).toContain(yoursStolen.id);
    expect(legal).not.toContain(theirsBorrowed.id);
    activate(ctx, self, /: \+2:/, yoursStolen.id);
    beginEndStep(ctx);
    settle(ctx);
    expect(
      named(ctx, 'Lab Bear')
        .filter((perm) => perm.ownerId === 'P1')
        .map((perm) => perm.controllerId),
    ).toEqual(['P1']);
  });

  it("venser-minus-one-unblockable — creatures can't be blocked this turn, including one that arrives afterwards (CR 611.2c)", () => {
    const ctx = pod('venser-minus');
    const self = spawn(ctx, 'P1', venser.card);
    spawn(ctx, 'P2', bear);
    activate(ctx, self, /: −1:/);
    expect(ctx.state.creaturesCantBeBlockedThisTurn).toBe(true);
    const late = spawn(ctx, 'P1', bear);
    const life = playerById(ctx, 'P2').life;
    const offered = attackP2(ctx);
    expect(offered).not.toContain(late.id);
    expect(playerById(ctx, 'P2').life).toBe(life - 2);
  });

  it('venser-minus-one-control — without it, the same attacker can be blocked', () => {
    const ctx = pod('venser-minus-control');
    spawn(ctx, 'P1', venser.card);
    spawn(ctx, 'P2', bear);
    const attacker = spawn(ctx, 'P1', bear);
    expect(attackP2(ctx)).toContain(attacker.id);
  });

  it('venser-minus-eight-emblem — the emblem exiles target permanent whenever you cast a spell', () => {
    const ctx = pod('venser-emblem');
    const self = spawn(ctx, 'P1', venser.card);
    self.counters['loyalty'] = 8;
    const theirs = spawn(ctx, 'P2', bear);
    activate(ctx, self, /: −8:/);
    expect(playerById(ctx, 'P1').emblems.map((emblem) => emblem.name)).toEqual([
      'Venser, the Sojourner emblem',
    ]);
    castFromHand(ctx, 'P1', divination, blue(1));
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual([
      'Venser, the Sojourner emblem',
    ]);
    settle(ctx, aim(theirs.id));
    expect(named(ctx, 'Lab Bear')).toEqual([]);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
  });

  it("venser-emblem-opponent-casts — an opponent's spell does not trigger your emblem", () => {
    const ctx = pod('venser-emblem-opponent');
    const self = spawn(ctx, 'P1', venser.card);
    self.counters['loyalty'] = 8;
    activate(ctx, self, /: −8:/);
    const spell = conjure(ctx, 'P2', LAB_BOLT, 'hand');
    expect(spell).toBeDefined();
    // Put P2's cast through the same cast-trigger scan as a cast from hand would.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    addMana(playerById(ctx, 'P2'), red(1));
    const option = optionFor(ctx, 'P2', spell.id);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P2',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P1']]),
    );
    expect(ctx.state.pendingTriggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.18 Puppeteer Clique
// ---------------------------------------------------------------------------------------------

const PUPPETEER_CLIQUE_SHA = '6cc92266c44c063db23abbdaf1b36dd0d9059367a482a19352ffa09749abb939';

describe('Puppeteer Clique', () => {
  const clique = pinned('Puppeteer Clique');
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const aim =
    (id: string): Answer =>
    (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) return { index: 0, targets: new Map([[slot.slot, id]]) };
      return { index: 0, targets: new Map() };
    };
  const bears = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Lab Bear');

  /** Clique enters for P1 and steals P2's Lab Bear from the graveyard. */
  function steal(seed: string) {
    const ctx = pod(seed);
    const card = conjure(ctx, 'P2', bear, 'graveyard');
    const self = enterFrom(ctx, 'P1', clique.card, 'hand');
    settle(ctx, aim(card.id));
    const [stolen] = bears(ctx);
    return { ctx, self, stolen: stolen! };
  }

  it('puppeteer-clique-pinned-oracle-supported — the interpreter models flying, the reanimation with its end-step exile, and persist', () => {
    expect(clique.sha256).toBe(PUPPETEER_CLIQUE_SHA);
    expectNoRegistration(clique.card);
    expectModeled(clique.card);
    const def = interpretCard(clique.card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers[0]!.targets).toEqual([
      {
        kind: 'cardInGraveyard',
        filter: { kind: 'type', value: 'Creature' },
        graveyardOwnerScope: 'opponent',
      },
    ]);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'reanimateTargetHasteExileAtYourNextEndStep', target: 0 },
    ]);
    expect(def.triggers[1]!.effects).toEqual([
      { op: 'returnDiedSourceToBattlefield', counter: '-1/-1' },
    ]);
  });

  it("puppeteer-clique-reanimates-with-haste — an opponent's creature card enters under your control with lasting haste", () => {
    const { ctx, stolen } = steal('clique-steal');
    expect(stolen.controllerId).toBe('P1');
    expect(stolen.ownerId).toBe('P2');
    expect(computeCharacteristics(ctx, stolen).keywords).toContain('haste');
    const grant = ctx.state.effects.find((effect) => effect.targetObjectIds?.includes(stolen.id));
    expect(grant?.duration).toBe('permanent');
  });

  it('puppeteer-clique-exiled-at-your-end-step — it is exiled at the beginning of your next end step', () => {
    const { ctx } = steal('clique-exile');
    beginEndStep(ctx);
    settle(ctx);
    expect(bears(ctx)).toEqual([]);
    expect(ctx.state.exile.map((card) => card.name)).toEqual(['Lab Bear']);
  });

  it("puppeteer-clique-not-their-end-step — another player's end step does not exile it", () => {
    const { ctx } = steal('clique-their-end');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    beginEndStep(ctx);
    settle(ctx);
    expect(bears(ctx)).toHaveLength(1);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    beginEndStep(ctx);
    settle(ctx);
    expect(bears(ctx)).toEqual([]);
  });

  it('puppeteer-clique-new-object-spared — once it left and came back, the delayed exile skips the new object (CR 400.7)', () => {
    const { ctx, stolen } = steal('clique-new-object');
    pump(moveObject(ctx, stolen, { zone: 'exile' }));
    pump(moveObject(ctx, ctx.state.exile[0]!, { zone: 'battlefield', controllerId: 'P2' }));
    beginEndStep(ctx);
    settle(ctx);
    expect(bears(ctx).map((perm) => perm.controllerId)).toEqual(['P2']);
  });

  it('puppeteer-clique-opponent-graveyard-only — a creature card in your own graveyard is not a legal target', () => {
    const ctx = pod('clique-own');
    const mine = conjure(ctx, 'P1', bear, 'graveyard');
    const theirs = conjure(ctx, 'P3', bear, 'graveyard');
    const spec = interpretCard(clique.card).triggers[0]!.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1');
    expect(legal).toContain(theirs.id);
    expect(legal).not.toContain(mine.id);
  });

  it('puppeteer-clique-persist — dying without a -1/-1 counter, it returns with one and steals again', () => {
    const { ctx, self } = steal('clique-persist');
    const second = conjure(ctx, 'P3', bear, 'graveyard');
    kill(ctx, self);
    settle(ctx, aim(second.id));
    const [back] = ctx.state.battlefield.filter((perm) => perm.name === 'Puppeteer Clique');
    expect(back?.counters).toEqual({ '-1/-1': 1 });
    expect(bears(ctx)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 3.02 Cryptek
// ---------------------------------------------------------------------------------------------

const CRYPTEK_SHA = '0e2e938f02e241942dfec466a4126d540bde0e05bf063a6dcfadfec206b85666';

describe('Cryptek', () => {
  const cryptek = pinned('Cryptek');
  const construct = oracle({
    name: 'Lab Construct',
    typeLine: 'Artifact Creature — Construct',
    power: '1',
    toughness: '1',
  });
  const bear = oracle({
    name: 'Lab Bear',
    typeLine: 'Creature — Bear',
    power: '2',
    toughness: '2',
  });
  const constructs = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Lab Construct');

  /** Activate Cryptek targeting `targetId` and resolve it. */
  function protect(ctx: GameContext, self: EnginePermanent, targetId: string) {
    addMana(playerById(ctx, 'P1'), [...generic(1), ...black(1)]);
    const option = optionFor(ctx, 'P1', self.id, /Choose another target artifact creature/);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, targetId]]),
    );
    resolveTop(ctx);
  }

  it('cryptek-pinned-oracle-supported — the interpreter models the {1}{B}, {T} dies-this-turn return', () => {
    expect(cryptek.sha256).toBe(CRYPTEK_SHA);
    expectNoRegistration(cryptek.card);
    expectModeled(cryptek.card);
    const [ability] = interpretCard(cryptek.card).activatedAbilities;
    expect(ability?.costs.map((cost) => cost.kind)).toEqual(['mana', 'tap']);
    expect(ability?.ability.targets).toEqual([
      {
        kind: 'creature',
        filter: { kind: 'allOf', of: [{ kind: 'other' }, { kind: 'type', value: 'Artifact' }] },
        controller: 'you',
      },
    ]);
    expect(ability?.ability.effects).toEqual([
      {
        op: 'registerDelayedTrigger',
        when: 'dies',
        target: 0,
        sameObject: true,
        expiry: 'cleanup',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'returnDiedTriggerObjectTapped' }],
          description: 'Return that creature to the battlefield tapped under your control',
        },
      },
    ]);
  });

  it('cryptek-returns-tapped — when the chosen creature dies this turn, it returns tapped under your control', () => {
    const ctx = pod('cryptek-return');
    const self = spawn(ctx, 'P1', cryptek.card);
    const ally = spawn(ctx, 'P1', construct);
    protect(ctx, self, ally.id);
    expect(self.tapped).toBe(true);
    kill(ctx, ally);
    settle(ctx);
    const [back] = constructs(ctx);
    expect(back?.tapped).toBe(true);
    expect(back?.controllerId).toBe('P1');
    expect(back?.id).not.toBe(ally.id);
  });

  it("cryptek-your-control — a creature you control but don't own returns under your control", () => {
    const ctx = pod('cryptek-stolen');
    const self = spawn(ctx, 'P1', cryptek.card);
    const borrowed = spawn(ctx, 'P2', construct);
    borrowed.controllerId = 'P1';
    protect(ctx, self, borrowed.id);
    kill(ctx, borrowed);
    settle(ctx);
    const [back] = constructs(ctx);
    expect(back?.ownerId).toBe('P2');
    expect(back?.controllerId).toBe('P1');
  });

  it('cryptek-this-turn-only — after cleanup, dying does not return it', () => {
    const ctx = pod('cryptek-expired');
    const self = spawn(ctx, 'P1', cryptek.card);
    const ally = spawn(ctx, 'P1', construct);
    protect(ctx, self, ally.id);
    // The cleanup step of this turn sweeps cleanup-scoped delayed triggers.
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter(
      (delayed) => delayed.expiry !== 'cleanup',
    );
    kill(ctx, ally);
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('cryptek-new-object — a creature that left and came back is a new object it does not watch (CR 400.7)', () => {
    const ctx = pod('cryptek-new-object');
    const self = spawn(ctx, 'P1', cryptek.card);
    const ally = spawn(ctx, 'P1', construct);
    protect(ctx, self, ally.id);
    pump(moveObject(ctx, ally, { zone: 'exile' }));
    pump(moveObject(ctx, ctx.state.exile[0]!, { zone: 'battlefield', controllerId: 'P1' }));
    kill(ctx, constructs(ctx)[0]!);
    expect(ctx.state.pendingTriggers).toEqual([]);
  });

  it('cryptek-card-moved-on — if the card left the graveyard before the return, nothing returns', () => {
    const ctx = pod('cryptek-moved-on');
    const self = spawn(ctx, 'P1', cryptek.card);
    const ally = spawn(ctx, 'P1', construct);
    protect(ctx, self, ally.id);
    kill(ctx, ally);
    pump(moveObject(ctx, playerById(ctx, 'P1').graveyard[0]!, { zone: 'exile' }));
    settle(ctx);
    expect(constructs(ctx)).toEqual([]);
  });

  it('cryptek-targets — only another artifact creature you control is a legal target', () => {
    const ctx = pod('cryptek-targets');
    const self = spawn(ctx, 'P1', cryptek.card);
    const ally = spawn(ctx, 'P1', construct);
    const bearPerm = spawn(ctx, 'P1', bear);
    const theirs = spawn(ctx, 'P2', construct);
    const spec = interpretCard(cryptek.card).activatedAbilities[0]!.ability.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1', [], undefined, undefined, self.cardId);
    expect(legal).toEqual([ally.id]);
    expect(legal).not.toContain(bearPerm.id);
    expect(legal).not.toContain(theirs.id);
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

/** Reviewed overrides deleted in PR03 because the interpreter now reads the same text. */
const RETIRED_REVIEWED_OVERRIDES = ['Blossoming Defense', 'Return to Nature'];

/** Cards restored in PR03. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Imotekh the Stormlord',
    sha256: '389742a3862725250d3388b5fa5f0200082ca1cf88295b1f2472ff1e31a9c14c',
    clauseCount: 2,
  },
  {
    name: 'Cryptek',
    sha256: CRYPTEK_SHA,
    clauseCount: 1,
  },
  {
    name: 'Puppeteer Clique',
    sha256: PUPPETEER_CLIQUE_SHA,
    clauseCount: 3,
  },
  {
    name: 'Venser, the Sojourner',
    sha256: VENSER_SHA,
    clauseCount: 3,
  },
  {
    name: 'Flickerwisp',
    sha256: FLICKERWISP_SHA,
    clauseCount: 2,
  },
  {
    name: 'Candlekeep Sage',
    sha256: CANDLEKEEP_SAGE_SHA,
    clauseCount: 1,
  },
  {
    name: 'God-Eternal Rhonas',
    sha256: '9df5c8f3e19a33b551697b160048537779dba35bd4d3e445302bd8e861ed57e6',
    clauseCount: 3,
  },
  {
    name: 'The Ooze',
    sha256: THE_OOZE_SHA,
    clauseCount: 2,
  },
  {
    name: 'Scavenging Ooze',
    sha256: '5e3b74f8d24d0bbc052267d35ec3e142201a4101036888a29689867fbf42b971',
    clauseCount: 1,
  },
  {
    name: 'Shard of the Void Dragon',
    sha256: 'fd95a3c55790914954c24c7f1db5acb38bf6d3721993864206f3541446b7f389',
    clauseCount: 3,
  },
  {
    name: 'Psychomancer',
    sha256: 'a9688ee818cfe44f6d23dd346d4e998a40205b0c24397080ecd37f21f26c481c',
    clauseCount: 2,
  },
  {
    name: 'Watcher for Tomorrow',
    sha256: '02360583993a6941a09046d20aefacec8e53d3acaa1cc092eee1f67eff3f2e57',
    clauseCount: 3,
  },
  {
    name: 'Aurora Phoenix',
    sha256: '4149988023167dc979f17457a84b42f8b357c111b9df094f8239783b568823db',
    clauseCount: 3,
  },
  {
    name: 'River Kelpie',
    sha256: 'd37cb44668d016bedab1375e97e13f1a178fadacc72ce65b5d17bc0509048c2c',
    clauseCount: 3,
  },
  {
    name: 'Keeper of Secrets',
    sha256: '4ef53442c20bda37718ff851155d979ab82ef135f39dc7da1f7076c9a88bdc5a',
    clauseCount: 2,
  },
  {
    name: 'Satoru, the Infiltrator',
    sha256: '61506504750f785352e9318aa606928d134418fd60f7036ea0a1c5c971b5b564',
    clauseCount: 2,
  },
  {
    name: 'Shard of the Nightbringer',
    sha256: '4c7f7779f494bcf3ef533a08cb6e5c2569a29f7845c354e2d31bb827a925ae3a',
    clauseCount: 2,
  },
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
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      // A reviewed override retired because the interpreter now reads its text keeps its earlier
      // reviewed evidence; it is not a PR03 restoration.
      if (RETIRED_REVIEWED_OVERRIDES.includes(entry.name)) continue;
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
