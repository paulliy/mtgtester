/**
 * PR05 card coverage: auras and equipment (docs/plans/card-coverage-chunks.md).
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
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import {
  beginEndStep,
  queueStepTriggers,
  runCombatAndExtraCombats,
  runTurn,
} from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT, hasKeyword } from '../src/state/queries';
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
  splitDamage,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/coverage-pr05-oracle.json'];
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

const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));
const black = (n: number) => Array.from({ length: n }, () => ({ symbol: 'B' as const }));

/** `playerId` casts `card` from hand through the normal legality/payment path with `mana`. */
function castFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: { symbol: 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }[],
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(playerById(ctx, playerId), mana);
  const option = optionFor(ctx, playerId, object.id);
  expect(option, `${playerId} casts ${card.name}`).toBeDefined();
  takeAction(ctx, playerId, option!.payload as PriorityActionPayload);
  return object;
}

/** Put `perm` into its owner's graveyard through the normal single-permanent zone change. */
function kill(ctx: GameContext, perm: EnginePermanent) {
  return pump(moveObject(ctx, perm, { zone: 'graveyard' }));
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
const LAB_ARTIFACT = (name: string) =>
  oracle({ name, typeLine: 'Artifact', manaCost: '{1}', power: null, toughness: null });

// ---------------------------------------------------------------------------------------------
// PR05.01 Ajani's Chosen
// ---------------------------------------------------------------------------------------------

describe("Ajani's Chosen", () => {
  const { card } = pinned("Ajani's Chosen");
  const ENCHANTMENT = oracle({
    name: 'Lab Ward',
    typeLine: 'Enchantment',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: '',
  });
  const AURA = oracle({
    name: 'Lab Blessing',
    typeLine: 'Enchantment — Aura',
    manaCost: '{0}',
    colors: ['W'],
    power: null,
    toughness: null,
    oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
  });
  const LAND_AURA = oracle({
    name: 'Lab Moss',
    typeLine: 'Enchantment — Aura',
    manaCost: '{0}',
    colors: ['G'],
    power: null,
    toughness: null,
    oracleText: 'Enchant land',
  });
  const HEX_AURA = oracle({
    name: 'Lab Hex',
    typeLine: 'Enchantment — Aura',
    manaCost: '{0}',
    colors: ['B'],
    power: null,
    toughness: null,
    oracleText: 'Enchant creature an opponent controls\nEnchanted creature gets -1/-1.',
  });
  const RESPONSE = oracle({
    name: 'Lab Response',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  /** P1 controls Ajani's Chosen, Lab Bear and a Forest; P2 controls Lab Enemy. */
  function board(seed: string) {
    const ctx = pod(seed);
    const chosen = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', LAB_CARD('Lab Bear'));
    const enemy = spawn(ctx, 'P2', LAB_CARD('Lab Enemy'));
    const forestPerm = spawn(ctx, 'P1', forest());
    return { ctx, chosen, bear, enemy, forestPerm };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const cats = (ctx: GameContext) => named(ctx, 'Cat');

  /** Cast an Aura from P1's hand onto `hostId` and resolve the spell; its triggers are pending. */
  function castAura(ctx: GameContext, aura: OracleCard, hostId: string) {
    const object = conjure(ctx, 'P1', aura, 'hand');
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, `P1 casts ${aura.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, hostId]]),
    );
    resolveTop(ctx);
    const [entered] = named(ctx, aura.name);
    expect(entered, `${aura.name} entered`).toBeDefined();
    expect(entered!.attachedTo).toBe(hostId);
    return entered!;
  }

  /** Answer the optional attach: take the attach option or decline it. */
  const attachAnswer =
    (choice: 'attach' | 'decline'): Answer =>
    (decision) => ({
      index: Math.max(
        decision.options.findIndex((option) => option.type === choice),
        0,
      ),
      targets: new Map(),
    });
  const attachPrompts = (decisions: PendingDecision[]) =>
    decisions.filter((decision) => decision.options.some((option) => option.type === 'attach'));

  it('ajanis-chosen-pinned-oracle-supported — the interpreter alone models the Cat token and the optional attach of an entering Aura to it', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.staticEffects).toEqual([]);
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // An enchantment you control entering, and nothing else.
    expect(trigger!.trigger).toEqual({
      when: 'enters',
      subject: {
        kind: 'permanent',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'type', value: 'Enchantment' },
          ],
        },
      },
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      {
        op: 'createToken',
        spec: {
          name: 'Cat',
          typeLine: 'Creature — Cat',
          types: ['Creature'],
          subtypes: ['Cat'],
          colors: ['W'],
          power: 2,
          toughness: 2,
        },
        count: { kind: 'const', n: 1 },
      },
      // The attach is its own optional step, only for an Aura, onto the token this trigger made.
      {
        op: 'attach',
        what: 'triggerObject',
        to: 'createdToken',
        requireAura: true,
        optional: true,
      },
    ]);
  });

  it("ajanis-chosen-cat-for-enchantment — a Cat for any enchantment you control entering, not an opponent's and not a nonenchantment", () => {
    const { ctx, chosen } = board('ajani-cat');
    const first = castFromHand(ctx, 'P1', ENCHANTMENT, []);
    resolveTop(ctx);
    const run = settle(ctx);
    expect(named(ctx, first.name)).toHaveLength(1);
    const [cat] = cats(ctx);
    expect(cats(ctx)).toHaveLength(1);
    expect(cat?.isToken).toBe(true);
    expect(cat?.controllerId).toBe('P1');
    expect(effectivePT(ctx, cat!)).toEqual({ power: 2, toughness: 2 });
    const chars = computeCharacteristics(ctx, cat!);
    expect(chars.types).toEqual(['Creature']);
    expect(chars.subtypes).toEqual(['Cat']);
    expect(chars.colors).toEqual(['W']);
    // A non-Aura enchantment has nothing to attach: no prompt at all, and it stays unattached.
    expect(attachPrompts(run.decisions)).toEqual([]);
    expect(named(ctx, first.name)[0]?.attachedTo ?? null).toBeNull();
    expect(ctx.state.stack).toEqual([]);

    // An enchantment creature is an enchantment too: a second Cat.
    const hybrid = oracle({
      name: 'Lab Spirit',
      typeLine: 'Enchantment Creature — Spirit',
      manaCost: '{0}',
    });
    castFromHand(ctx, 'P1', hybrid, []);
    resolveTop(ctx);
    settle(ctx);
    expect(cats(ctx)).toHaveLength(2);

    // Negative: an enchantment an opponent controls entering gives you nothing.
    const opposed = board('ajani-cat-opponent');
    const theirs = conjure(opposed.ctx, 'P2', ENCHANTMENT, 'hand');
    pump(moveObject(opposed.ctx, theirs, { zone: 'battlefield' }));
    settle(opposed.ctx);
    expect(named(opposed.ctx, 'Lab Ward')).toHaveLength(1);
    expect(cats(opposed.ctx)).toEqual([]);

    // Negative: your own nonenchantment permanents entering (a creature, an artifact) give nothing.
    const plain = board('ajani-cat-nonenchantment');
    castFromHand(plain.ctx, 'P1', LAB_CARD('Lab Newcomer'), []);
    resolveTop(plain.ctx);
    castFromHand(plain.ctx, 'P1', LAB_ARTIFACT('Lab Trinket'), generic(1));
    resolveTop(plain.ctx);
    settle(plain.ctx);
    expect(named(plain.ctx, 'Lab Newcomer')).toHaveLength(1);
    expect(named(plain.ctx, 'Lab Trinket')).toHaveLength(1);
    expect(cats(plain.ctx)).toEqual([]);
    // The Cat itself is not an enchantment, so it does not start a chain.
    expect(chosen.attachedTo ?? null).toBeNull();
  });

  it('ajanis-chosen-aura-optional-attach — an Aura entering offers the optional attach: yes moves it to the Cat with a new timestamp, no leaves it', () => {
    const yes = board('ajani-attach-yes');
    const aura = castAura(yes.ctx, AURA, yes.bear.id);
    const stamp = aura.timestamp;
    expect(effectivePT(yes.ctx, yes.bear)).toEqual({ power: 3, toughness: 3 });
    const run = settle(yes.ctx, attachAnswer('attach'));
    const [cat] = cats(yes.ctx);
    expect(cats(yes.ctx)).toHaveLength(1);
    // One prompt, offering the Cat and a way to decline.
    const prompts = attachPrompts(run.decisions);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.options.map((option) => option.type).sort()).toEqual(['attach', 'decline']);
    expect(prompts[0]!.options.find((option) => option.type === 'attach')?.description).toMatch(
      /Cat/,
    );
    // The Aura moved: the Cat carries the +1/+1 now, the Bear lost it, and it is a new timestamp.
    expect(aura.attachedTo).toBe(cat?.id);
    expect(aura.timestamp).toBeGreaterThan(stamp);
    expect(effectivePT(yes.ctx, cat!)).toEqual({ power: 3, toughness: 3 });
    expect(effectivePT(yes.ctx, yes.bear)).toEqual({ power: 2, toughness: 2 });
    expect(named(yes.ctx, 'Lab Blessing')).toHaveLength(1);
    expect(yes.ctx.state.stack).toEqual([]);

    // Declining keeps the Aura on its creature at its old timestamp; the Cat is still made.
    const no = board('ajani-attach-no');
    const kept = castAura(no.ctx, AURA, no.bear.id);
    const keptStamp = kept.timestamp;
    const declined = settle(no.ctx, attachAnswer('decline'));
    expect(attachPrompts(declined.decisions)).toHaveLength(1);
    expect(cats(no.ctx)).toHaveLength(1);
    expect(kept.attachedTo).toBe(no.bear.id);
    expect(kept.timestamp).toBe(keptStamp);
    expect(effectivePT(no.ctx, no.bear)).toEqual({ power: 3, toughness: 3 });
    expect(effectivePT(no.ctx, cats(no.ctx)[0]!)).toEqual({ power: 2, toughness: 2 });
  });

  it("ajanis-chosen-aura-illegal-or-gone — an Aura that can't enchant the Cat, or that left, doesn't move (CR 701.3b)", () => {
    // "Enchant land": the Cat is not a land, so there is nothing to attach to and nothing to ask.
    const land = board('ajani-attach-land');
    const moss = castAura(land.ctx, LAND_AURA, land.forestPerm.id);
    const mossStamp = moss.timestamp;
    const landRun = settle(land.ctx, attachAnswer('attach'));
    expect(attachPrompts(landRun.decisions)).toEqual([]);
    expect(cats(land.ctx)).toHaveLength(1);
    expect(moss.attachedTo).toBe(land.forestPerm.id);
    expect(moss.timestamp).toBe(mossStamp);

    // "Enchant creature an opponent controls": your Cat is not a legal host either.
    const hex = board('ajani-attach-hex');
    const hexed = castAura(hex.ctx, HEX_AURA, hex.enemy.id);
    const hexRun = settle(hex.ctx, attachAnswer('attach'));
    expect(attachPrompts(hexRun.decisions)).toEqual([]);
    expect(cats(hex.ctx)).toHaveLength(1);
    expect(hexed.attachedTo).toBe(hex.enemy.id);
    expect(effectivePT(hex.ctx, hex.enemy)).toEqual({ power: 1, toughness: 1 });
    expect(effectivePT(hex.ctx, cats(hex.ctx)[0]!)).toEqual({ power: 2, toughness: 2 });

    // The Aura leaves the battlefield while the trigger is on the stack: the Cat is still made,
    // the Aura stays in the graveyard, and nothing is asked.
    const gone = board('ajani-attach-gone');
    const blessing = castAura(gone.ctx, AURA, gone.bear.id);
    conjure(gone.ctx, 'P1', RESPONSE, 'hand');
    let responded = false;
    const goneDecisions: PendingDecision[] = [];
    pump(runPrioritySequence(gone.ctx), (decision) => {
      goneDecisions.push(decision);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0 && !responded && gone.ctx.state.stack.length > 0) {
        responded = true;
        kill(gone.ctx, blessing);
      }
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(responded, 'a player held priority with the trigger on the stack').toBe(true);
    expect(attachPrompts(goneDecisions)).toEqual([]);
    expect(cats(gone.ctx)).toHaveLength(1);
    expect(named(gone.ctx, 'Lab Blessing')).toEqual([]);
    expect(playerById(gone.ctx, 'P1').graveyard.map((c) => c.name)).toEqual(['Lab Blessing']);
    expect(effectivePT(gone.ctx, cats(gone.ctx)[0]!)).toEqual({ power: 2, toughness: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.02 Cranial Plating
// ---------------------------------------------------------------------------------------------

describe('Cranial Plating', () => {
  const { card } = pinned('Cranial Plating');
  const ATTACH = /Attach this Equipment/;
  const EQUIP = /: Equip \{1\}$/;

  /** P1 controls Plating (unattached) and two 2/2 creatures; an opponent controls a third. */
  function board(seed: string) {
    const ctx = pod(seed);
    const plating = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', LAB_CARD('Lab First'));
    const second = spawn(ctx, 'P1', LAB_CARD('Lab Second'));
    const enemy = spawn(ctx, 'P2', LAB_CARD('Lab Enemy'));
    return { ctx, plating, first, second, enemy };
  }

  /** The target slot's legal objects for the option, by name. */
  function targetNames(ctx: GameContext, option: NonNullable<ReturnType<typeof optionFor>>) {
    const nameOf = (id: string) => ctx.state.battlefield.find((perm) => perm.id === id)?.name ?? id;
    return option.targets!.flatMap((slot) => slot.options.map(nameOf)).sort();
  }

  it('cranial-plating-pinned-oracle-supported — the interpreter alone models the static and both attach activations', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.activatedAbilities).toHaveLength(2);
    const [attach, equip] = def.activatedAbilities;
    // {B}{B}: Attach this Equipment to target creature you control. (instant speed)
    expect(attach!.timing).toBe('any');
    expect(attach!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 0, colored: { W: 0, U: 0, B: 2, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(attach!.ability.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(attach!.ability.effects).toEqual([{ op: 'attachSelfTo', target: 0 }]);
    // Equip {1}: sorcery speed (CR 702.6a).
    expect(equip!.timing).toBe('sorcery');
    expect(equip!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(equip!.ability.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(equip!.ability.effects).toEqual([{ op: 'attachSelfTo', target: 0 }]);
    // Equipped creature gets +1/+0 for each artifact you control: a layer 7d power modification.
    expect(def.staticEffects).toHaveLength(1);
    const [pump] = def.staticEffects;
    expect(pump!.affects).toEqual({ kind: 'attachedToSource' });
    expect(pump!.op).toMatchObject({
      layer: 7,
      sublayer: 'd',
      power: {
        kind: 'times',
        n: 1,
        of: {
          kind: 'countPermanents',
          scope: 'you',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'controller', who: 'you' },
              { kind: 'type', value: 'Artifact' },
            ],
          },
        },
      },
    });
  });

  it('cranial-plating-pump-per-artifact — the equipped creature gets +1/+0 per artifact you control, and nothing else', () => {
    const { ctx, plating, first, second } = board('plating-pump');
    // Unattached, Plating pumps nothing.
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });

    plating.attachedTo = first.id;
    // Plating is itself an artifact you control: +1/+0. Toughness is untouched.
    expect(effectivePT(ctx, first)).toEqual({ power: 3, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });

    // Another artifact you control grows it again.
    spawn(ctx, 'P1', LAB_ARTIFACT('Lab Trinket'));
    expect(effectivePT(ctx, first)).toEqual({ power: 4, toughness: 2 });
    // An artifact creature counts too.
    spawn(ctx, 'P1', oracle({ name: 'Lab Servo', typeLine: 'Artifact Creature — Servo' }));
    expect(effectivePT(ctx, first)).toEqual({ power: 5, toughness: 2 });

    // An opponent's artifact is not an artifact you control.
    spawn(ctx, 'P2', LAB_ARTIFACT('Lab Enemy Trinket'));
    expect(effectivePT(ctx, first)).toEqual({ power: 5, toughness: 2 });

    // The count is live: when one of your artifacts leaves, the creature shrinks again.
    const trinket = ctx.state.battlefield.find((perm) => perm.name === 'Lab Trinket')!;
    kill(ctx, trinket);
    expect(effectivePT(ctx, first)).toEqual({ power: 4, toughness: 2 });
  });

  it('cranial-plating-instant-speed-attach — {B}{B} moves it with a spell on the stack or on an opponent’s turn; Equip {1} is sorcery speed', () => {
    const { ctx, plating, first, second } = board('plating-instant');
    plating.attachedTo = first.id;
    addMana(playerById(ctx, 'P1'), [...black(2), ...generic(1)]);

    // Your main phase with an empty stack: both are offered.
    expect(optionFor(ctx, 'P1', plating.id, ATTACH)).toBeDefined();
    expect(optionFor(ctx, 'P1', plating.id, EQUIP)).toBeDefined();

    // A spell on the stack: only the instant-speed attach remains.
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
    expect(optionFor(ctx, 'P1', plating.id, EQUIP)).toBeUndefined();
    const attach = optionFor(ctx, 'P1', plating.id, ATTACH);
    expect(attach).toBeDefined();
    // The creature it is already on is not a meaningful target; the other one is.
    expect(targetNames(ctx, attach!)).toEqual(['Lab Second']);
    takeAction(
      ctx,
      'P1',
      attach!.payload as PriorityActionPayload,
      undefined,
      new Map([[attach!.targets![0]!.slot, second.id]]),
    );
    // The attach ability is on the stack above the spell; Plating has not moved yet.
    expect(ctx.state.stack).toHaveLength(2);
    expect(plating.attachedTo).toBe(first.id);
    resolveTop(ctx);
    expect(plating.attachedTo).toBe(second.id);
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 3, toughness: 2 });
    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);

    // An opponent's turn: the attach is still offered and moves it back; Equip {1} is not.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    addMana(playerById(ctx, 'P1'), [...black(2), ...generic(1)]);
    expect(optionFor(ctx, 'P1', plating.id, EQUIP)).toBeUndefined();
    const back = optionFor(ctx, 'P1', plating.id, ATTACH);
    expect(back).toBeDefined();
    expect(targetNames(ctx, back!)).toEqual(['Lab First']);
    takeAction(
      ctx,
      'P1',
      back!.payload as PriorityActionPayload,
      undefined,
      new Map([[back!.targets![0]!.slot, first.id]]),
    );
    resolveTop(ctx);
    expect(plating.attachedTo).toBe(first.id);
    expect(effectivePT(ctx, first)).toEqual({ power: 3, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });
  });

  it('cranial-plating-target-you-control — an opponent’s creature is not a legal target of either ability', () => {
    const { ctx, plating } = board('plating-targets');
    addMana(playerById(ctx, 'P1'), [...black(2), ...generic(1)]);
    for (const pattern of [ATTACH, EQUIP]) {
      const option = optionFor(ctx, 'P1', plating.id, pattern);
      expect(option, String(pattern)).toBeDefined();
      expect(targetNames(ctx, option!), String(pattern)).toEqual(['Lab First', 'Lab Second']);
    }
  });

  it('cranial-plating-target-gone — if the target leaves before the attach resolves, Plating stays where it was', () => {
    const { ctx, plating, first, second } = board('plating-gone');
    plating.attachedTo = first.id;
    addMana(playerById(ctx, 'P1'), black(2));
    const attach = optionFor(ctx, 'P1', plating.id, ATTACH)!;
    takeAction(
      ctx,
      'P1',
      attach.payload as PriorityActionPayload,
      undefined,
      new Map([[attach.targets![0]!.slot, second.id]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
    kill(ctx, second);
    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    // The ability fizzled (CR 608.2b): Plating is still on the first creature.
    expect(plating.attachedTo).toBe(first.id);
    expect(effectivePT(ctx, first)).toEqual({ power: 3, toughness: 2 });

    // The same holds for an unattached Plating and Equip {1}.
    const other = board('plating-gone-equip');
    addMana(playerById(other.ctx, 'P1'), generic(1));
    const equip = optionFor(other.ctx, 'P1', other.plating.id, EQUIP)!;
    takeAction(
      other.ctx,
      'P1',
      equip.payload as PriorityActionPayload,
      undefined,
      new Map([[equip.targets![0]!.slot, other.first.id]]),
    );
    kill(other.ctx, other.first);
    resolveTop(other.ctx);
    expect(other.plating.attachedTo ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.03 Forum Filibuster
// ---------------------------------------------------------------------------------------------

describe('Forum Filibuster', () => {
  const { card } = pinned('Forum Filibuster');
  const AURA = (name: string, enchant = 'creature') =>
    oracle({
      name,
      typeLine: 'Enchantment — Aura',
      manaCost: '{0}',
      colors: ['W'],
      power: null,
      toughness: null,
      oracleText: `Enchant ${enchant}\nEnchanted ${enchant} gets +1/+1.`,
    });
  const BLESSING = AURA('Lab Blessing');
  const MOSS = oracle({
    name: 'Lab Moss',
    typeLine: 'Enchantment — Aura',
    manaCost: '{0}',
    colors: ['G'],
    power: null,
    toughness: null,
    oracleText: 'Enchant land',
  });
  const BLADE = oracle({
    name: 'Lab Blade',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Equipped creature gets +2/+0.\nEquip {1}',
  });
  const WARD = oracle({
    name: 'Lab Ward',
    typeLine: 'Enchantment',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: '',
  });
  const RESPONSE = oracle({
    name: 'Lab Response',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  /** P1 controls Forum Filibuster; its graveyard holds every kind of card, P2's holds an Aura. */
  function board(seed: string) {
    const ctx = pod(seed);
    const filibuster = spawn(ctx, 'P1', card);
    const mine = {
      blessing: conjure(ctx, 'P1', BLESSING, 'graveyard'),
      moss: conjure(ctx, 'P1', MOSS, 'graveyard'),
      blade: conjure(ctx, 'P1', BLADE, 'graveyard'),
      ward: conjure(ctx, 'P1', WARD, 'graveyard'),
      corpse: conjure(ctx, 'P1', LAB_CARD('Lab Corpse'), 'graveyard'),
    };
    const theirs = conjure(ctx, 'P2', AURA('Lab Enemy Aura'), 'graveyard');
    return { ctx, filibuster, mine, theirs };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const yard = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);

  interface Run {
    /** The "Target …" options each target-choice prompt offered. */
    offered: string[][];
  }

  /** Begin `playerId`'s upkeep and run the priority loop, choosing `pick` for the Filibuster. */
  function upkeep(
    ctx: GameContext,
    pick: string | null,
    opts: { playerId?: string; meanwhile?: (token: EnginePermanent) => void } = {},
  ): Run {
    const playerId = opts.playerId ?? 'P1';
    ctx.state.currentTurnPlayer = playerId;
    ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
    ctx.state.phase = 'beginning';
    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    const run: Run = { offered: [] };
    let responded = false;
    if (opts.meanwhile !== undefined) conjure(ctx, 'P1', RESPONSE, 'hand');
    pump(runPrioritySequence(ctx), (decision) => {
      const targets = decision.options.filter((option) => option.type === 'pickTarget');
      if (targets.length > 0) {
        run.offered.push(targets.map((option) => option.description.replace(/^Target /, '')));
        const index = decision.options.findIndex(
          (option) => option.type === 'pickTarget' && option.description === `Target ${pick}`,
        );
        if (index >= 0) return { index, targets: new Map() };
        return {
          index: decision.options.findIndex((option) => option.type === 'decline'),
          targets: new Map(),
        };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) {
        // The reflexive trigger is on the stack above the token: the token dies in response.
        const token = named(ctx, 'Inkling')[0];
        if (
          opts.meanwhile !== undefined &&
          !responded &&
          token !== undefined &&
          ctx.state.stack.length > 0
        ) {
          responded = true;
          opts.meanwhile(token);
        }
        return { index: pass, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });
    if (opts.meanwhile !== undefined)
      expect(responded, 'a player held priority with the reflexive trigger on the stack').toBe(
        true,
      );
    return run;
  }

  it('forum-filibuster-pinned-oracle-supported — the interpreter alone models the Inkling and its reflexive Aura or Equipment return', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.staticEffects).toEqual([]);
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // Your upkeep only, with no target of its own.
    expect(trigger!.trigger).toEqual({ when: 'upkeep', player: 'you' });
    expect(trigger!.targets).toEqual([]);
    const [create, reflexive] = trigger!.effects;
    expect(create).toEqual({
      op: 'createToken',
      spec: {
        name: 'Inkling',
        typeLine: 'Creature — Inkling',
        types: ['Creature'],
        subtypes: ['Inkling'],
        colors: ['W', 'B'],
        power: 2,
        toughness: 1,
        keywords: ['flying'],
      },
      count: { kind: 'const', n: 1 },
    });
    expect(trigger!.effects).toHaveLength(2);
    // "When you do": a reflexive ability (CR 603.12) with up to one Aura or Equipment card target.
    expect(reflexive).toMatchObject({ op: 'reflexiveOnCreatedToken' });
    const then = (reflexive as { then: { targets: unknown[]; effects: unknown[] } }).then;
    expect(then.targets).toEqual([
      {
        kind: 'cardInGraveyard',
        count: { min: 0, max: 1 },
        filter: {
          kind: 'anyOf',
          of: [
            { kind: 'subtype', value: 'Aura' },
            { kind: 'subtype', value: 'Equipment' },
          ],
        },
      },
    ]);
    expect(then.effects).toEqual([
      { op: 'returnChosenCardsAttachedTo', targetSlot: 0, to: 'triggerObject' },
    ]);
  });

  it('forum-filibuster-upkeep-token — only your upkeep creates a 2/1 white and black flying Inkling', () => {
    const { ctx } = board('forum-token');
    upkeep(ctx, null);
    const [inkling] = named(ctx, 'Inkling');
    expect(named(ctx, 'Inkling')).toHaveLength(1);
    expect(inkling?.controllerId).toBe('P1');
    expect(effectivePT(ctx, inkling!)).toEqual({ power: 2, toughness: 1 });
    expect(hasKeyword(ctx, inkling!, 'flying')).toBe(true);
    const chars = computeCharacteristics(ctx, inkling!);
    expect([...chars.colors].sort()).toEqual(['B', 'W']);
    expect(chars.subtypes).toEqual(['Inkling']);

    // Negative: an opponent's upkeep makes nothing for you, and it asks about nothing.
    const other = board('forum-token-opponent');
    const run = upkeep(other.ctx, 'Lab Blessing', { playerId: 'P2' });
    expect(named(other.ctx, 'Inkling')).toEqual([]);
    expect(run.offered).toEqual([]);
    expect(yard(other.ctx, 'P1')).toContain('Lab Blessing');
  });

  it('forum-filibuster-reflexive-targets — it targets up to one Aura or Equipment card in your graveyard only, and choosing none is legal', () => {
    const { ctx, mine } = board('forum-targets');
    const run = upkeep(ctx, null);
    // Exactly the Auras and the Equipment in P1's graveyard: not P2's Aura, not a non-Aura
    // enchantment, not a creature card.
    expect(run.offered).toHaveLength(1);
    expect([...run.offered[0]!].sort()).toEqual(['Lab Blade', 'Lab Blessing', 'Lab Moss']);
    // Choosing none returns nothing: the Inkling is still made and the graveyards are untouched.
    expect(named(ctx, 'Inkling')).toHaveLength(1);
    expect(yard(ctx, 'P1').sort()).toEqual(
      [mine.blessing, mine.moss, mine.blade, mine.ward, mine.corpse].map((c) => c.name).sort(),
    );
    expect(yard(ctx, 'P2')).toEqual(['Lab Enemy Aura']);
    expect(ctx.state.stack).toEqual([]);

    // With no Aura or Equipment card to choose, nothing is asked and the Inkling still arrives.
    const bare = pod('forum-targets-empty');
    spawn(bare, 'P1', card);
    conjure(bare, 'P1', WARD, 'graveyard');
    const none = upkeep(bare, null);
    expect(none.offered).toEqual([]);
    expect(named(bare, 'Inkling')).toHaveLength(1);
  });

  it('forum-filibuster-attached-return — an Aura returns attached to the Inkling and an Equipment returns and is attached to it', () => {
    const aura = board('forum-aura');
    upkeep(aura.ctx, 'Lab Blessing');
    const [inkling] = named(aura.ctx, 'Inkling');
    const [blessing] = named(aura.ctx, 'Lab Blessing');
    expect(blessing?.controllerId).toBe('P1');
    expect(blessing?.attachedTo).toBe(inkling?.id);
    expect(effectivePT(aura.ctx, inkling!)).toEqual({ power: 3, toughness: 2 });
    expect(yard(aura.ctx, 'P1')).not.toContain('Lab Blessing');
    // Only the chosen card moved.
    expect(yard(aura.ctx, 'P1')).toContain('Lab Blade');
    expect(named(aura.ctx, 'Lab Blade')).toEqual([]);
    expect(yard(aura.ctx, 'P2')).toEqual(['Lab Enemy Aura']);

    const equipment = board('forum-equipment');
    upkeep(equipment.ctx, 'Lab Blade');
    const [token] = named(equipment.ctx, 'Inkling');
    const [blade] = named(equipment.ctx, 'Lab Blade');
    expect(blade?.controllerId).toBe('P1');
    expect(blade?.attachedTo).toBe(token?.id);
    expect(effectivePT(equipment.ctx, token!)).toEqual({ power: 4, toughness: 1 });
    expect(named(equipment.ctx, 'Lab Blessing')).toEqual([]);
    expect(equipment.ctx.state.stack).toEqual([]);
  });

  it("forum-filibuster-token-gone-or-illegal — an Aura stays in the graveyard if the token is gone (CR 303.4i) or can't be enchanted, an Equipment enters unattached (CR 301.5e)", () => {
    // The Inkling dies while the reflexive trigger is on the stack: the Aura stays put.
    const aura = board('forum-gone-aura');
    upkeep(aura.ctx, 'Lab Blessing', { meanwhile: (token) => kill(aura.ctx, token) });
    expect(named(aura.ctx, 'Inkling')).toEqual([]);
    expect(named(aura.ctx, 'Lab Blessing')).toEqual([]);
    expect(yard(aura.ctx, 'P1')).toContain('Lab Blessing');

    // The Equipment still enters, unattached.
    const equipment = board('forum-gone-equipment');
    upkeep(equipment.ctx, 'Lab Blade', { meanwhile: (token) => kill(equipment.ctx, token) });
    const [blade] = named(equipment.ctx, 'Lab Blade');
    expect(blade).toBeDefined();
    expect(blade?.controllerId).toBe('P1');
    expect(blade?.attachedTo ?? null).toBeNull();
    expect(yard(equipment.ctx, 'P1')).not.toContain('Lab Blade');

    // An Aura that cannot enchant a creature ("enchant land") is a legal target but stays in the
    // graveyard; the Inkling is still made.
    const land = board('forum-illegal');
    upkeep(land.ctx, 'Lab Moss');
    expect(named(land.ctx, 'Inkling')).toHaveLength(1);
    expect(named(land.ctx, 'Lab Moss')).toEqual([]);
    expect(yard(land.ctx, 'P1')).toContain('Lab Moss');
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.04 Ghoulish Impetus
// ---------------------------------------------------------------------------------------------

describe('Ghoulish Impetus', () => {
  const { card } = pinned('Ghoulish Impetus');
  const CREATURE = (name: string, power = '2', toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Secret', power, toughness });
  const HEXPROOF = oracle({
    name: 'Lab Hexproof',
    typeLine: 'Creature — Secret',
    power: '2',
    toughness: '2',
    oracleText: 'Hexproof',
    keywords: ['Hexproof'],
  });
  const IMPETUS_MANA = [{ symbol: 'B' as const }, ...generic(2)];

  /**
   * P1 controls Ghoulish Impetus enchanting Lab Bear, plus Lab Ally and a 0/6 Lab Wall; P2
   * controls Lab Enemy and a hexproof creature. Everything is already on the battlefield.
   */
  function board(seed: string) {
    const ctx = pod(seed);
    const impetus = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const ally = spawn(ctx, 'P1', CREATURE('Lab Ally'));
    const wall = spawn(ctx, 'P2', CREATURE('Lab Wall', '0', '6'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const hexproof = spawn(ctx, 'P2', HEXPROOF);
    impetus.attachedTo = bear.id;
    return { ctx, impetus, bear, ally, wall, enemy, hexproof };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const graveyardOf = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);

  /** An answer that picks the Aura host by name and records every host choice offered. */
  function chooseHost(name: string | null, offered: string[][] = []): Answer {
    return (decision) => {
      const hosts = decision.options.filter((option) => option.type === 'attachAura');
      if (hosts.length === 0) return { index: 0, targets: new Map() };
      offered.push(hosts.map((option) => option.description.replace(/^Enchant /, '')));
      const index = hosts.findIndex((option) => option.description === `Enchant ${name}`);
      return { index: decision.options.indexOf(hosts[Math.max(index, 0)]!), targets: new Map() };
    };
  }

  /** Kill `perm` and let its dies trigger resolve; the card then waits for the next end step. */
  function die(ctx: GameContext, perm: EnginePermanent) {
    kill(ctx, perm);
    return settle(ctx);
  }

  /** Begin the end step and let the delayed trigger resolve, choosing the host by `name`. */
  function endStep(ctx: GameContext, name: string | null = null, offered: string[][] = []) {
    beginEndStep(ctx);
    return settle(ctx, chooseHost(name, offered));
  }

  /** P1's combat; `blocks` maps a blocker to its attacker. Everything in `attackers` attacks P2. */
  function combat(ctx: GameContext, attackers: string[], blocks = new Map<string, string>()) {
    return pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P2' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks.get(subjectId) ?? null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  /** A whole turn for the current turn player with nobody attacking or blocking. */
  function quietTurn(ctx: GameContext) {
    return pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (_id, subject) =>
          subject.mustAttack ? (subject.defenders[0]?.playerId ?? null) : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
  }

  /** The attack declaration `P2` is offered on its own turn, as the engine presents it. */
  function p2AttackSubjects(ctx: GameContext) {
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const seen: { name: string; mustAttack: boolean; defenders: string[] }[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        for (const subject of decision.presentationAttackDeclaration.subjects)
          seen.push({
            name: subject.name,
            mustAttack: subject.mustAttack,
            defenders: subject.defenders.map((defender) => defender.playerId),
          });
        return declareAttacks(decision, (_id, subject) =>
          subject.mustAttack ? (subject.defenders[0]?.playerId ?? null) : null,
        );
      }
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return seen;
  }

  it('ghoulish-impetus-pinned-oracle-supported — the interpreter alone models the +1/+1, deathtouch and goad and the next-end-step return', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    // Enchanted creature gets +1/+1, has deathtouch, and is goaded: three statics on the host only.
    expect(def.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'deathtouch' } },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addGoad: true } },
    ]);
    // When enchanted creature dies, return this card ... at the beginning of the next end step.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'dies',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'returnDepartedSourceToBattlefield', delay: 'nextEndStep' },
    ]);
  });

  it('ghoulish-impetus-enchant-creature — it is cast targeting a creature, never a player or a noncreature permanent, and attaches on resolution', () => {
    const ctx = pod('impetus-cast');
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const hexproof = spawn(ctx, 'P2', HEXPROOF);
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const relic = spawn(ctx, 'P1', LAB_ARTIFACT('Lab Relic'));
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), IMPETUS_MANA);
    const option = optionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    const legal = option!.targets!.flatMap((slot) => slot.options).sort();
    expect(legal).toEqual([bear.id, enemy.id].sort());
    expect(legal).not.toContain(hexproof.id);
    expect(legal).not.toContain(relic.id);
    expect(legal).not.toContain('P2');
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, enemy.id]]),
    );
    resolveTop(ctx);
    const [aura] = named(ctx, 'Ghoulish Impetus');
    expect(aura?.attachedTo).toBe(enemy.id);
    expect(aura?.controllerId).toBe('P1');
    expect(effectivePT(ctx, enemy)).toEqual({ power: 3, toughness: 3 });
    expect(effectivePT(ctx, bear)).toEqual({ power: 2, toughness: 2 });
  });

  it('ghoulish-impetus-buff-enchanted-only — the enchanted creature gets +1/+1 and deathtouch and is goaded; nothing else is', () => {
    const { ctx, impetus, bear, ally, enemy } = board('impetus-buff');
    const goaded = (perm: EnginePermanent) =>
      computeCharacteristics(ctx, perm).staticGoadedBy ?? [];
    expect(effectivePT(ctx, bear)).toEqual({ power: 3, toughness: 3 });
    expect(hasKeyword(ctx, bear, 'deathtouch')).toBe(true);
    expect(goaded(bear)).toEqual(['P1']);
    for (const other of [ally, enemy]) {
      expect(effectivePT(ctx, other)).toEqual({ power: 2, toughness: 2 });
      expect(hasKeyword(ctx, other, 'deathtouch')).toBe(false);
      expect(goaded(other)).toEqual([]);
    }
    // Moved onto another creature, all three move with it.
    impetus.attachedTo = enemy.id;
    expect(effectivePT(ctx, enemy)).toEqual({ power: 3, toughness: 3 });
    expect(hasKeyword(ctx, enemy, 'deathtouch')).toBe(true);
    expect(goaded(enemy)).toEqual(['P1']);
    expect(effectivePT(ctx, bear)).toEqual({ power: 2, toughness: 2 });
    expect(hasKeyword(ctx, bear, 'deathtouch')).toBe(false);
    expect(goaded(bear)).toEqual([]);
    // Unattached it grants nothing to anybody.
    impetus.attachedTo = null;
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    expect(hasKeyword(ctx, enemy, 'deathtouch')).toBe(false);
    expect(goaded(enemy)).toEqual([]);
  });

  it('ghoulish-impetus-deathtouch-combat — in real combat the enchanted creature kills any blocker it damages; an unenchanted creature of the same power does not', () => {
    // Enchanted Bear (3/3 deathtouch) blocked by the 0/6 Wall deals 3 damage: the Wall dies.
    const hit = board('impetus-deathtouch');
    combat(hit.ctx, [hit.bear.id], new Map([[hit.wall.id, hit.bear.id]]));
    expect(named(hit.ctx, 'Lab Wall')).toEqual([]);
    expect(graveyardOf(hit.ctx, 'P2')).toEqual(['Lab Wall']);
    expect(named(hit.ctx, 'Lab Bear')).toHaveLength(1);

    // Control: the unenchanted Ally has power 2 against toughness 6 and no deathtouch.
    const miss = board('impetus-no-deathtouch');
    combat(miss.ctx, [miss.bear.id, miss.ally.id], new Map([[miss.wall.id, miss.ally.id]]));
    expect(named(miss.ctx, 'Lab Wall')).toHaveLength(1);
    expect(named(miss.ctx, 'Lab Ally')).toHaveLength(1);
    // The unblocked enchanted Bear connected for 3.
    expect(playerById(miss.ctx, 'P2').life).toBe(37);
  });

  it("ghoulish-impetus-goaded — the enchanted creature must attack each combat and attacks a player other than the Aura's controller; unenchanted creatures are free", () => {
    // P2's creature enchanted by P1's Aura: it must attack, and never P1 while P3 or P4 can be.
    const hit = board('impetus-goad');
    hit.impetus.attachedTo = hit.enemy.id;
    const seen = p2AttackSubjects(hit.ctx);
    const goaded = seen.find((subject) => subject.name === 'Lab Enemy');
    expect(goaded?.mustAttack).toBe(true);
    expect(goaded?.defenders.sort()).toEqual(['P3', 'P4']);
    // P2's other creatures have no requirement and may attack P1 or decline.
    const free = seen.find((subject) => subject.name === 'Lab Wall');
    expect(free?.mustAttack).toBe(false);
    expect(free?.defenders.sort()).toEqual(['P1', 'P3', 'P4']);
    // It really attacked: one of P3 or P4 took damage, P1 did not.
    const lifeOf = (id: string) => playerById(hit.ctx, id).life;
    expect(lifeOf('P1')).toBe(40);
    expect(lifeOf('P3') + lifeOf('P4')).toBe(77);

    // Unattached, the Aura goads nobody.
    const bare = board('impetus-goad-bare');
    bare.impetus.attachedTo = null;
    const none = p2AttackSubjects(bare.ctx);
    expect(none.every((subject) => !subject.mustAttack)).toBe(true);
  });

  it('ghoulish-impetus-dies-trigger-enchanted-only — only the creature this Aura enchants dying sets up the return', () => {
    // The enchanted creature dies: exactly one delayed return is set up.
    const hit = board('impetus-dies');
    die(hit.ctx, hit.bear);
    expect(hit.ctx.state.delayedTriggers).toHaveLength(1);
    expect(hit.ctx.state.delayedTriggers[0]!.when).toBe('endStep');
    expect(graveyardOf(hit.ctx, 'P1').sort()).toEqual(['Ghoulish Impetus', 'Lab Bear']);

    // Another creature, yours or an opponent's, dying sets up nothing; the Aura stays on its host.
    const beside = board('impetus-dies-other');
    die(beside.ctx, beside.ally);
    die(beside.ctx, beside.enemy);
    expect(beside.ctx.state.delayedTriggers).toEqual([]);
    expect(beside.impetus.attachedTo).toBe(beside.bear.id);
    endStep(beside.ctx);
    expect(named(beside.ctx, 'Ghoulish Impetus')).toEqual([beside.impetus]);

    // The Aura itself leaving (destroyed) while the creature lives is not the creature dying.
    const destroyed = board('impetus-aura-dies');
    die(destroyed.ctx, destroyed.impetus);
    expect(destroyed.ctx.state.delayedTriggers).toEqual([]);
    endStep(destroyed.ctx);
    expect(named(destroyed.ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(graveyardOf(destroyed.ctx, 'P1')).toEqual(['Ghoulish Impetus']);

    // The enchanted creature leaving without dying (exile, bounce) sets up nothing.
    const exiled = board('impetus-creature-exiled');
    pump(moveObject(exiled.ctx, exiled.bear, { zone: 'exile' }));
    settle(exiled.ctx);
    expect(exiled.ctx.state.delayedTriggers).toEqual([]);
    const bounced = board('impetus-creature-bounced');
    pump(moveObject(bounced.ctx, bounced.bear, { zone: 'hand' }));
    settle(bounced.ctx);
    expect(bounced.ctx.state.delayedTriggers).toEqual([]);
    endStep(bounced.ctx);
    expect(named(bounced.ctx, 'Ghoulish Impetus')).toEqual([]);
  });

  it('ghoulish-impetus-next-end-step — the card returns at the beginning of the next end step, not immediately, and its controller chooses a creature to enchant as it enters', () => {
    const { ctx, impetus, bear, ally, enemy, hexproof } = board('impetus-return');
    die(ctx, bear);
    // The return waits: one delayed trigger that lasts until it fires (past cleanup).
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]!.expiry).toBe('onFire');
    // Not immediately: further priority passes and other steps return nothing.
    settle(ctx);
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    settle(ctx);
    expect(named(ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(graveyardOf(ctx, 'P1')).toContain('Ghoulish Impetus');

    // The beginning of the end step: the trigger goes on the stack, and the Aura returns when it
    // resolves, choosing among every creature (the hexproof one included) but not the dead Bear.
    const offered: string[][] = [];
    beginEndStep(ctx);
    expect(named(ctx, 'Ghoulish Impetus')).toEqual([]);
    settle(ctx, chooseHost('Lab Ally', offered));
    const [back] = named(ctx, 'Ghoulish Impetus');
    expect(back).toBeDefined();
    expect(back?.id).not.toBe(impetus.id);
    expect(back?.controllerId).toBe('P1');
    expect(back?.attachedTo).toBe(ally.id);
    expect(offered).toHaveLength(1);
    expect([...offered[0]!].sort()).toEqual(
      ['Lab Ally', 'Lab Enemy', 'Lab Hexproof', 'Lab Wall'].sort(),
    );
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab Bear']);
    expect(ctx.state.delayedTriggers).toEqual([]);
    // The returned Aura is a new object that works again: its host is 3/3 deathtouch.
    expect(effectivePT(ctx, ally)).toEqual({ power: 3, toughness: 3 });
    expect(hasKeyword(ctx, ally, 'deathtouch')).toBe(true);
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    expect(hexproof.attachedTo ?? null).toBeNull();

    // Spent: the new Aura's host dying sets up a fresh return, and no stale one fires.
    die(ctx, ally);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    endStep(ctx, 'Lab Enemy');
    expect(named(ctx, 'Ghoulish Impetus')[0]?.attachedTo).toBe(enemy.id);
    endStep(ctx);
    expect(named(ctx, 'Ghoulish Impetus')).toHaveLength(1);
  });

  it("ghoulish-impetus-next-end-step-any-turn — an end step that already began is not the next one; the return waits through cleanup for the following end step, whoever's turn it is", () => {
    // Dying during this turn's end step: that end step has begun, so it does not return then.
    const late = board('impetus-in-end-step');
    beginEndStep(late.ctx);
    settle(late.ctx);
    die(late.ctx, late.bear);
    expect(named(late.ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(late.ctx.state.delayedTriggers).toHaveLength(1);
    // P2's whole turn runs: it returns at P2's end step (the next to begin), under P1's control.
    late.ctx.state.currentTurnPlayer = 'P2';
    late.ctx.state.activePlayerIndex = 1;
    quietTurn(late.ctx);
    expect(named(late.ctx, 'Ghoulish Impetus')).toHaveLength(1);
    expect(named(late.ctx, 'Ghoulish Impetus')[0]?.controllerId).toBe('P1');
    expect(late.ctx.state.delayedTriggers).toEqual([]);

    // Dying during an opponent's turn returns it at the end of that same turn.
    const theirs = board('impetus-opponents-turn');
    theirs.ctx.state.currentTurnPlayer = 'P2';
    theirs.ctx.state.activePlayerIndex = 1;
    die(theirs.ctx, theirs.bear);
    expect(named(theirs.ctx, 'Ghoulish Impetus')).toEqual([]);
    endStep(theirs.ctx);
    expect(named(theirs.ctx, 'Ghoulish Impetus')).toHaveLength(1);
  });

  it('ghoulish-impetus-stays-put — with no creature to enchant it stays in the graveyard (CR 303.4i), and a card that left the graveyard first stays where it went (CR 400.7)', () => {
    // No creature anywhere at the end step: nothing to enchant, so it stays in the graveyard.
    const lonely = pod('impetus-lonely');
    const aura = spawn(lonely, 'P1', card);
    const dying = spawn(lonely, 'P1', CREATURE('Lab Bear'));
    aura.attachedTo = dying.id;
    die(lonely, dying);
    const offered: string[][] = [];
    endStep(lonely, null, offered);
    expect(offered).toEqual([]);
    expect(named(lonely, 'Ghoulish Impetus')).toEqual([]);
    expect(graveyardOf(lonely, 'P1').sort()).toEqual(['Ghoulish Impetus', 'Lab Bear']);

    // A creature that appears before the end step gives it a host after all.
    const late = pod('impetus-late-creature');
    const lateAura = spawn(late, 'P1', card);
    const lateDying = spawn(late, 'P1', CREATURE('Lab Bear'));
    lateAura.attachedTo = lateDying.id;
    die(late, lateDying);
    const newcomer = spawn(late, 'P2', CREATURE('Lab Newcomer'));
    endStep(late, 'Lab Newcomer');
    expect(named(late, 'Ghoulish Impetus')[0]?.attachedTo).toBe(newcomer.id);

    const died = (seed: string) => {
      const b = board(seed);
      die(b.ctx, b.bear);
      expect(b.ctx.state.delayedTriggers).toHaveLength(1);
      return b;
    };
    const auraCard = (ctx: GameContext) => {
      const found = playerById(ctx, 'P1').graveyard.find((c) => c.name === 'Ghoulish Impetus');
      expect(found).toBeDefined();
      return found!;
    };

    // Exiled from the graveyard first: it stays in exile.
    const exiled = died('impetus-left-exile');
    pump(moveObject(exiled.ctx, auraCard(exiled.ctx), { zone: 'exile' }));
    endStep(exiled.ctx, 'Lab Ally');
    expect(named(exiled.ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(exiled.ctx.state.exile.map((c) => c.name)).toEqual(['Ghoulish Impetus']);
    expect(exiled.ctx.state.delayedTriggers).toEqual([]);

    // Returned to hand first: it stays in hand.
    const hand = died('impetus-left-hand');
    pump(moveObject(hand.ctx, auraCard(hand.ctx), { zone: 'hand' }));
    endStep(hand.ctx, 'Lab Ally');
    expect(named(hand.ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(playerById(hand.ctx, 'P1').hand.map((c) => c.name)).toEqual(['Ghoulish Impetus']);

    // Left and came back as a new object: that is not the card the trigger remembers.
    const again = died('impetus-left-and-back');
    pump(moveObject(again.ctx, auraCard(again.ctx), { zone: 'hand' }));
    const inHand = playerById(again.ctx, 'P1').hand.find((c) => c.name === 'Ghoulish Impetus');
    pump(moveObject(again.ctx, inHand!, { zone: 'graveyard' }));
    endStep(again.ctx, 'Lab Ally');
    expect(named(again.ctx, 'Ghoulish Impetus')).toEqual([]);
    expect(graveyardOf(again.ctx, 'P1')).toContain('Ghoulish Impetus');

    // Control: untouched in the graveyard, it returns.
    const control = died('impetus-left-control');
    endStep(control.ctx, 'Lab Ally');
    expect(named(control.ctx, 'Ghoulish Impetus')).toHaveLength(1);
  });

  it("ghoulish-impetus-returns-under-controller — an Aura you control but an opponent owns returns from the owner's graveyard under the control of the player whose ability returns it", () => {
    const { ctx, impetus, bear, ally } = board('impetus-owner');
    impetus.ownerId = 'P2';
    die(ctx, bear);
    // It went to its owner's graveyard, and waits there.
    expect(graveyardOf(ctx, 'P2')).toEqual(['Ghoulish Impetus']);
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab Bear']);
    const offered: string[][] = [];
    endStep(ctx, 'Lab Ally', offered);
    // P1's delayed trigger returns it (CR 110.2a), and P1 chooses what it enchants.
    const [back] = named(ctx, 'Ghoulish Impetus');
    expect(back?.ownerId).toBe('P2');
    expect(back?.controllerId).toBe('P1');
    expect(back?.attachedTo).toBe(ally.id);
    expect(graveyardOf(ctx, 'P2')).toEqual([]);
    expect(offered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.05 Gift of Immortality
// ---------------------------------------------------------------------------------------------

describe('Gift of Immortality', () => {
  const { card } = pinned('Gift of Immortality');
  const CREATURE = (name: string, power = '2', toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Secret', power, toughness });
  const RESPONSE = oracle({
    name: 'Lab Response',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });
  const GIFT_MANA = [{ symbol: 'W' as const }, ...generic(2)];

  /**
   * P1 controls Gift of Immortality enchanting Lab Bear, plus Lab Ally; P2 controls Lab Enemy.
   * Everything is already on the battlefield.
   */
  function board(seed: string) {
    const ctx = pod(seed);
    const gift = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const ally = spawn(ctx, 'P1', CREATURE('Lab Ally'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    gift.attachedTo = bear.id;
    return { ctx, gift, bear, ally, enemy };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const graveyardOf = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);
  const inYard = (ctx: GameContext, playerId: string, name: string) => {
    const found = playerById(ctx, playerId).graveyard.find((c) => c.name === name);
    expect(found, `${name} in ${playerId}'s graveyard`).toBeDefined();
    return found!;
  };

  /** Kill `perm` and let its dies trigger resolve. */
  function die(ctx: GameContext, perm: EnginePermanent) {
    kill(ctx, perm);
    return settle(ctx);
  }

  /**
   * Kill `perm`, then run the priority loop; the first time a player holds priority with the
   * trigger on the stack, `meanwhile` runs (state changes made in response to it).
   */
  function dieThenRespond(ctx: GameContext, perm: EnginePermanent, meanwhile: () => void) {
    kill(ctx, perm);
    // A free instant in hand makes priority a real choice (not a forced pass) with the trigger up.
    conjure(ctx, 'P1', RESPONSE, 'hand');
    let responded = false;
    pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0 && !responded && ctx.state.stack.length > 0) {
        responded = true;
        meanwhile();
      }
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(responded, 'a player held priority with the trigger on the stack').toBe(true);
  }

  /** A whole turn for the current turn player with nobody attacking or blocking. */
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

  it('gift-of-immortality-pinned-oracle-supported — the interpreter alone models the owner-controlled creature return and the attached Aura return', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    // The Aura has no static effect: it changes nothing about the creature it enchants.
    expect(def.staticEffects).toEqual([]);
    // One dies trigger on the enchanted creature only, with no target and two ordered effects.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'dies',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'graveyardToBattlefield', target: 'triggerObject', under: 'owner' },
      { op: 'returnDepartedSourceToBattlefield', delay: 'nextEndStep', attachTo: 'triggerObject' },
    ]);
  });

  it('gift-of-immortality-enchant-creature — it is cast targeting a creature, never a player or a noncreature permanent, attaches on resolution, and changes nothing about its creature', () => {
    const ctx = pod('gift-cast');
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const relic = spawn(ctx, 'P1', LAB_ARTIFACT('Lab Relic'));
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), GIFT_MANA);
    const option = optionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    const legal = option!.targets!.flatMap((slot) => slot.options).sort();
    expect(legal).toEqual([bear.id, enemy.id].sort());
    expect(legal).not.toContain(relic.id);
    expect(legal).not.toContain('P2');
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, bear.id]]),
    );
    resolveTop(ctx);
    const [aura] = named(ctx, 'Gift of Immortality');
    expect(aura?.attachedTo).toBe(bear.id);
    expect(aura?.controllerId).toBe('P1');
    // It grants no bonus or keyword: the creature is exactly what it was.
    expect(effectivePT(ctx, bear)).toEqual({ power: 2, toughness: 2 });
    expect(hasKeyword(ctx, bear, 'deathtouch')).toBe(false);
  });

  it('gift-of-immortality-creature-returns-now — when the enchanted creature dies it returns to the battlefield at once, as a new object', () => {
    const { ctx, gift, bear, ally } = board('gift-now');
    die(ctx, bear);
    // The creature card is back already, with no waiting for an end step.
    const [back] = named(ctx, 'Lab Bear');
    expect(back).toBeDefined();
    expect(back?.id).not.toBe(bear.id);
    expect(back?.controllerId).toBe('P1');
    expect(graveyardOf(ctx, 'P1')).toEqual(['Gift of Immortality']);
    expect(ctx.state.stack).toEqual([]);
    // The Aura is not back yet: it waits for the next end step, attached to nothing meanwhile.
    expect(named(ctx, 'Gift of Immortality')).toEqual([]);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]!.when).toBe('endStep');
    expect(ctx.state.delayedTriggers[0]!.expiry).toBe('onFire');
    expect(gift.attachedTo).toBe(bear.id);
    expect(ally.attachedTo ?? null).toBeNull();
    // Another creature dying is not "enchanted creature": nothing returns for it.
    const beside = board('gift-now-other');
    die(beside.ctx, beside.ally);
    expect(named(beside.ctx, 'Lab Ally')).toEqual([]);
    expect(graveyardOf(beside.ctx, 'P1')).toEqual(['Lab Ally']);
    expect(beside.ctx.state.delayedTriggers).toEqual([]);
    expect(beside.gift.attachedTo).toBe(beside.bear.id);
  });

  it('gift-of-immortality-creature-under-owner — a creature you control but an opponent owns returns under its owner, not you; one you own returns under you', () => {
    const { ctx, gift, enemy } = board('gift-owner');
    // P1 controls a creature P2 owns, and enchants it with the Gift.
    const stolen = spawn(ctx, 'P2', CREATURE('Lab Stolen'));
    stolen.controllerId = 'P1';
    gift.attachedTo = stolen.id;
    die(ctx, stolen);
    // It died into its owner's graveyard and came straight back under that owner's control.
    expect(graveyardOf(ctx, 'P2')).toEqual([]);
    const [back] = named(ctx, 'Lab Stolen');
    expect(back?.ownerId).toBe('P2');
    expect(back?.controllerId).toBe('P2');
    expect(
      ctx.state.battlefield.filter((p) => p.controllerId === 'P1' && p.name === 'Lab Stolen'),
    ).toEqual([]);
    // At the end step the Aura comes back under ITS controller P1, attached to the P2 creature.
    beginEndStep(ctx);
    settle(ctx);
    const [aura] = named(ctx, 'Gift of Immortality');
    expect(aura?.controllerId).toBe('P1');
    expect(aura?.attachedTo).toBe(back?.id);
    expect(enemy.attachedTo ?? null).toBeNull();

    // A creature you own and control returns under your control.
    const mine = board('gift-owner-mine');
    die(mine.ctx, mine.bear);
    expect(named(mine.ctx, 'Lab Bear')[0]?.controllerId).toBe('P1');
  });

  it('gift-of-immortality-aura-returns-attached — at the beginning of the next end step the Aura returns attached to that creature, not before and with no choice of host', () => {
    const { ctx, gift, bear, ally, enemy } = board('gift-end-step');
    die(ctx, bear);
    const [back] = named(ctx, 'Lab Bear');
    // Not before the end step: other steps and priority passes return nothing.
    settle(ctx);
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    settle(ctx);
    expect(named(ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(ctx, 'P1')).toEqual(['Gift of Immortality']);

    // The end step begins: the trigger goes on the stack, and the Aura returns when it resolves,
    // attached to the creature that came back, with no host decision offered.
    const decisions: string[] = [];
    beginEndStep(ctx);
    expect(named(ctx, 'Gift of Immortality')).toEqual([]);
    settle(ctx, (decision) => {
      decisions.push(decision.prompt);
      return { index: 0, targets: new Map() };
    });
    expect(decisions.filter((prompt) => /choose a permanent to enchant/.test(prompt))).toEqual([]);
    const [aura] = named(ctx, 'Gift of Immortality');
    expect(aura).toBeDefined();
    expect(aura?.id).not.toBe(gift.id);
    expect(aura?.controllerId).toBe('P1');
    expect(aura?.attachedTo).toBe(back?.id);
    expect(aura?.attachedTo).not.toBe(ally.id);
    expect(aura?.attachedTo).not.toBe(enemy.id);
    expect(graveyardOf(ctx, 'P1')).toEqual([]);
    expect(ctx.state.delayedTriggers).toEqual([]);

    // The returned Aura works again: its creature dying brings both back once more.
    die(ctx, back!);
    expect(named(ctx, 'Lab Bear')).toHaveLength(1);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Gift of Immortality')[0]?.attachedTo).toBe(named(ctx, 'Lab Bear')[0]?.id);
    // Spent: a later end step returns nothing more.
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Gift of Immortality')).toHaveLength(1);
  });

  it("gift-of-immortality-next-end-step-any-turn — an end step that already began is not the next one; the Aura waits through cleanup for the following end step, whoever's turn it is", () => {
    // Dying during this turn's end step: that end step has begun, so the Aura does not return then.
    const late = board('gift-in-end-step');
    beginEndStep(late.ctx);
    settle(late.ctx);
    die(late.ctx, late.bear);
    expect(named(late.ctx, 'Lab Bear')).toHaveLength(1);
    expect(named(late.ctx, 'Gift of Immortality')).toEqual([]);
    expect(late.ctx.state.delayedTriggers).toHaveLength(1);
    // P2's whole turn runs: the Aura returns at P2's end step, attached to the returned creature.
    late.ctx.state.currentTurnPlayer = 'P2';
    late.ctx.state.activePlayerIndex = 1;
    quietTurn(late.ctx);
    const [aura] = named(late.ctx, 'Gift of Immortality');
    expect(aura?.attachedTo).toBe(named(late.ctx, 'Lab Bear')[0]?.id);
    expect(late.ctx.state.delayedTriggers).toEqual([]);

    // Dying during an opponent's turn returns the Aura at the end of that same turn.
    const theirs = board('gift-opponents-turn');
    theirs.ctx.state.currentTurnPlayer = 'P2';
    theirs.ctx.state.activePlayerIndex = 1;
    die(theirs.ctx, theirs.bear);
    expect(named(theirs.ctx, 'Lab Bear')).toHaveLength(1);
    expect(named(theirs.ctx, 'Gift of Immortality')).toEqual([]);
    beginEndStep(theirs.ctx);
    settle(theirs.ctx);
    expect(named(theirs.ctx, 'Gift of Immortality')).toHaveLength(1);
  });

  it('gift-of-immortality-creature-gone — if that creature left the battlefield or became a new object before the end step, the Aura stays in the graveyard', () => {
    const returned = (seed: string) => {
      const b = board(seed);
      die(b.ctx, b.bear);
      const back = named(b.ctx, 'Lab Bear')[0]!;
      expect(back).toBeDefined();
      expect(b.ctx.state.delayedTriggers).toHaveLength(1);
      return { ...b, back };
    };
    const finish = (ctx: GameContext) => {
      beginEndStep(ctx);
      settle(ctx);
    };

    // Control: the creature is still there, so the Aura returns onto it.
    const control = returned('gift-gone-control');
    finish(control.ctx);
    expect(named(control.ctx, 'Gift of Immortality')[0]?.attachedTo).toBe(control.back.id);

    // It died again: the Aura stays in the graveyard (the delayed trigger is spent).
    const died = returned('gift-gone-died');
    die(died.ctx, died.back);
    finish(died.ctx);
    expect(named(died.ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(died.ctx, 'P1')).toContain('Gift of Immortality');
    expect(died.ctx.state.delayedTriggers).toEqual([]);

    // It was exiled.
    const exiled = returned('gift-gone-exiled');
    pump(moveObject(exiled.ctx, exiled.back, { zone: 'exile' }));
    finish(exiled.ctx);
    expect(named(exiled.ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(exiled.ctx, 'P1')).toEqual(['Gift of Immortality']);

    // It was bounced and came back as a new object: not "that creature" any more.
    const blinked = returned('gift-gone-blinked');
    pump(moveObject(blinked.ctx, blinked.back, { zone: 'hand' }));
    const card = playerById(blinked.ctx, 'P1').hand.find((c) => c.name === 'Lab Bear');
    pump(moveObject(blinked.ctx, card!, { zone: 'battlefield', controllerId: 'P1' }));
    const [again] = named(blinked.ctx, 'Lab Bear');
    expect(again?.id).not.toBe(blinked.back.id);
    finish(blinked.ctx);
    expect(named(blinked.ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(blinked.ctx, 'P1')).toEqual(['Gift of Immortality']);
    expect(again?.attachedTo ?? null).toBeNull();
  });

  it('gift-of-immortality-left-graveyard — a creature card that left the graveyard before the trigger resolves returns nothing, and an Aura card that left first stays where it went', () => {
    // The creature card is exiled in response: nothing returns, and there is no creature to attach to.
    const creature = board('gift-card-exiled');
    dieThenRespond(creature.ctx, creature.bear, () => {
      pump(moveObject(creature.ctx, inYard(creature.ctx, 'P1', 'Lab Bear'), { zone: 'exile' }));
    });
    expect(named(creature.ctx, 'Lab Bear')).toEqual([]);
    expect(creature.ctx.state.exile.map((c) => c.name)).toEqual(['Lab Bear']);
    expect(creature.ctx.state.delayedTriggers).toEqual([]);
    beginEndStep(creature.ctx);
    settle(creature.ctx);
    expect(named(creature.ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(creature.ctx, 'P1')).toContain('Gift of Immortality');

    // The creature card left and came back as a new object: that is not the card it remembers.
    const again = board('gift-card-new-object');
    dieThenRespond(again.ctx, again.bear, () => {
      pump(moveObject(again.ctx, inYard(again.ctx, 'P1', 'Lab Bear'), { zone: 'hand' }));
      const inHand = playerById(again.ctx, 'P1').hand.find((c) => c.name === 'Lab Bear');
      pump(moveObject(again.ctx, inHand!, { zone: 'graveyard' }));
    });
    expect(named(again.ctx, 'Lab Bear')).toEqual([]);
    expect(graveyardOf(again.ctx, 'P1')).toContain('Lab Bear');

    // The Aura card is exiled in response: the creature still returns, but the Aura never does.
    const aura = board('gift-aura-exiled');
    dieThenRespond(aura.ctx, aura.bear, () => {
      pump(moveObject(aura.ctx, inYard(aura.ctx, 'P1', 'Gift of Immortality'), { zone: 'exile' }));
    });
    expect(named(aura.ctx, 'Lab Bear')).toHaveLength(1);
    expect(aura.ctx.state.delayedTriggers).toEqual([]);
    beginEndStep(aura.ctx);
    settle(aura.ctx);
    expect(named(aura.ctx, 'Gift of Immortality')).toEqual([]);
    expect(aura.ctx.state.exile.map((c) => c.name)).toEqual(['Gift of Immortality']);

    // The Aura card leaves the graveyard after the trigger, before the end step: it stays there.
    const later = board('gift-aura-exiled-later');
    die(later.ctx, later.bear);
    pump(moveObject(later.ctx, inYard(later.ctx, 'P1', 'Gift of Immortality'), { zone: 'hand' }));
    beginEndStep(later.ctx);
    settle(later.ctx);
    expect(named(later.ctx, 'Gift of Immortality')).toEqual([]);
    expect(playerById(later.ctx, 'P1').hand.map((c) => c.name)).toEqual(['Gift of Immortality']);

    // A token that dies ceases to exist: no card returns and the Aura has nothing to attach to.
    const token = board('gift-token');
    const dying = spawn(token.ctx, 'P1', CREATURE('Lab Token'), { isToken: true });
    token.gift.attachedTo = dying.id;
    die(token.ctx, dying);
    beginEndStep(token.ctx);
    settle(token.ctx);
    expect(named(token.ctx, 'Lab Token')).toEqual([]);
    expect(named(token.ctx, 'Gift of Immortality')).toEqual([]);
    expect(graveyardOf(token.ctx, 'P1')).toEqual(['Gift of Immortality']);
  });

  it('gift-of-immortality-enchanted-dies-only — the Aura leaving alone, or its creature leaving without dying, returns nothing', () => {
    // The Aura itself destroyed while its creature lives: not the creature dying.
    const destroyed = board('gift-aura-dies');
    die(destroyed.ctx, destroyed.gift);
    expect(destroyed.ctx.state.delayedTriggers).toEqual([]);
    beginEndStep(destroyed.ctx);
    settle(destroyed.ctx);
    expect(named(destroyed.ctx, 'Gift of Immortality')).toEqual([]);
    expect(named(destroyed.ctx, 'Lab Bear')).toEqual([destroyed.bear]);

    // The enchanted creature exiled or bounced does not die, so nothing comes back.
    const exiled = board('gift-creature-exiled');
    pump(moveObject(exiled.ctx, exiled.bear, { zone: 'exile' }));
    settle(exiled.ctx);
    expect(exiled.ctx.state.delayedTriggers).toEqual([]);
    expect(named(exiled.ctx, 'Lab Bear')).toEqual([]);
    const bounced = board('gift-creature-bounced');
    pump(moveObject(bounced.ctx, bounced.bear, { zone: 'hand' }));
    settle(bounced.ctx);
    beginEndStep(bounced.ctx);
    settle(bounced.ctx);
    expect(bounced.ctx.state.delayedTriggers).toEqual([]);
    expect(named(bounced.ctx, 'Gift of Immortality')).toEqual([]);
    expect(named(bounced.ctx, 'Lab Bear')).toEqual([]);
    expect(playerById(bounced.ctx, 'P1').hand.map((c) => c.name)).toEqual(['Lab Bear']);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.07 Karametra's Favor
// ---------------------------------------------------------------------------------------------

describe("Karametra's Favor", () => {
  const { card } = pinned("Karametra's Favor");
  const CREATURE = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });
  const SPELL = (name: string, cost: string) =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost: cost,
      power: null,
      toughness: null,
      oracleText: 'You gain 1 life.',
    });
  const BY_COLOR = [
    ['W', SPELL('Lab White Spell', '{W}')],
    ['U', SPELL('Lab Blue Spell', '{U}')],
    ['B', SPELL('Lab Black Spell', '{B}')],
    ['R', SPELL('Lab Red Spell', '{R}')],
    ['G', SPELL('Lab Green Spell', '{G}')],
  ] as const;
  const RED = SPELL('Lab Red Spell', '{R}');

  /** P1 controls Karametra's Favor on Lab Host, plus Lab Other; P2 controls Lab Enemy. */
  function board(seed: string, host: { summoningSick?: boolean } = {}) {
    const ctx = pod(seed);
    const aura = spawn(ctx, 'P1', card);
    const hostPerm = spawn(ctx, 'P1', CREATURE('Lab Host'), host);
    const other = spawn(ctx, 'P1', CREATURE('Lab Other'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    aura.attachedTo = hostPerm.id;
    return { ctx, aura, host: hostPerm, other, enemy };
  }

  /** The cast option for `spell` from `playerId`'s hand with an empty mana pool, if offered. */
  function castOption(ctx: GameContext, playerId: string, spell: OracleCard) {
    const object = conjure(ctx, playerId, spell, 'hand');
    return { object, option: optionFor(ctx, playerId, object.id) };
  }

  it('karametras-favor-pinned-oracle-supported — the interpreter alone models the enters draw and the granted any-color mana ability', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.spellAbility?.effects).toEqual([]);
    // "When this Aura enters, draw a card": one untargeted trigger on the Aura itself.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([{ op: 'draw', count: { kind: 'const', n: 1 } }]);
    // The Aura grants a mana ability, a layer 6 grant on the enchanted creature, and no stats: the
    // printed text has no +1/+1, and the Aura has no mana ability of its own.
    expect(def.manaAbilities ?? []).toEqual([]);
    expect(def.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 6, addManaAbility: { units: [['W', 'U', 'B', 'R', 'G']] } },
      },
    ]);
  });

  it('karametras-favor-enters-draw — the Aura entering draws one card for its controller, and nothing else does', () => {
    const ctx = pod('karametra-draw');
    const host = spawn(ctx, 'P1', CREATURE('Lab Host'));
    const p1 = playerById(ctx, 'P1');
    const handBefore = p1.hand.length;
    const libraryBefore = p1.library.length;
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(p1, [{ symbol: 'G' }, ...generic(1)]);
    const option = optionFor(ctx, 'P1', object.id);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, host.id]]),
    );
    resolveTop(ctx);
    // The Aura is on the battlefield enchanting Lab Host and has not drawn yet (the trigger waits).
    const aura = ctx.state.battlefield.find((perm) => perm.name === "Karametra's Favor");
    expect(aura?.attachedTo).toBe(host.id);
    settle(ctx);
    // One card came off the library; the Aura itself left the hand and nothing else drew.
    expect(p1.library).toHaveLength(libraryBefore - 1);
    expect(p1.hand).toHaveLength(handBefore + 1);
    expect(playerById(ctx, 'P2').hand).toHaveLength(0);
    expect(ctx.state.stack).toEqual([]);

    // Negative: an Aura already on the battlefield draws nothing when other permanents enter, and a
    // second Aura entering draws only for itself.
    const quiet = board('karametra-draw-quiet');
    const quietHand = playerById(quiet.ctx, 'P1').hand.length;
    castFromHand(quiet.ctx, 'P1', CREATURE('Lab Newcomer'), generic(1));
    resolveTop(quiet.ctx);
    settle(quiet.ctx);
    expect(playerById(quiet.ctx, 'P1').hand).toHaveLength(quietHand);
  });

  it('karametras-favor-any-color-mana — the enchanted creature taps for one mana of any color, and only it does', () => {
    // Every color pays for a spell of that color, with nothing in the pool and no other source.
    for (const [color, spell] of BY_COLOR) {
      const { ctx, host } = board(`karametra-color-${color}`);
      const { option } = castOption(ctx, 'P1', spell);
      expect(option, `${color} spell is castable with the enchanted creature`).toBeDefined();
      takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
      // The creature tapped to pay, and the spell is on the stack.
      expect(host.tapped).toBe(true);
      expect(ctx.state.stack).toHaveLength(1);
      resolveTop(ctx);
      expect(playerById(ctx, 'P1').life).toBe(41);
    }

    // One mana only: a {R}{R} spell is not castable with a single enchanted creature.
    const single = board('karametra-one-mana');
    expect(castOption(single.ctx, 'P1', SPELL('Lab Double Red', '{R}{R}')).option).toBeUndefined();

    // Negative: with the Aura unattached, or for a creature it is not on, nothing pays.
    const bare = board('karametra-unattached');
    bare.aura.attachedTo = null;
    expect(castOption(bare.ctx, 'P1', RED).option).toBeUndefined();
    const elsewhere = board('karametra-elsewhere');
    elsewhere.aura.attachedTo = elsewhere.other.id;
    // Lab Host no longer pays; Lab Other, now enchanted, does.
    const paid = castOption(elsewhere.ctx, 'P1', RED);
    expect(paid.option).toBeDefined();
    takeAction(elsewhere.ctx, 'P1', paid.option!.payload as PriorityActionPayload);
    expect(elsewhere.other.tapped).toBe(true);
    expect(elsewhere.host.tapped).toBe(false);
    // The creature has no stats from the Aura: its power and toughness are unchanged.
    expect(effectivePT(elsewhere.ctx, elsewhere.other)).toEqual({ power: 2, toughness: 2 });
    // Once tapped it cannot pay again.
    expect(castOption(elsewhere.ctx, 'P1', RED).option).toBeUndefined();
  });

  it("karametras-favor-controller-only — the mana ability belongs to the creature's controller, even when the Aura's controller is someone else", () => {
    const { ctx, aura, enemy } = board('karametra-controller');
    // P1's Aura enchants P2's creature: P2 can tap it for mana, P1 cannot.
    aura.attachedTo = enemy.id;
    expect(castOption(ctx, 'P1', RED).option).toBeUndefined();
    const theirs = castOption(ctx, 'P2', RED);
    expect(theirs.option).toBeDefined();
    takeAction(ctx, 'P2', theirs.option!.payload as PriorityActionPayload);
    expect(enemy.tapped).toBe(true);
  });

  it('karametras-favor-summoning-sick — a creature that came under your control this turn cannot tap for the granted mana (CR 302.6)', () => {
    const sick = board('karametra-sick', { summoningSick: true });
    expect(castOption(sick.ctx, 'P1', RED).option).toBeUndefined();
    expect(sick.host.tapped).toBe(false);
    // Once it has been under your control since the turn began, it can.
    sick.host.summoningSick = false;
    const ready = castOption(sick.ctx, 'P1', RED);
    expect(ready.option).toBeDefined();
    takeAction(sick.ctx, 'P1', ready.option!.payload as PriorityActionPayload);
    expect(sick.host.tapped).toBe(true);
    // A haste creature is not bound by it.
    const hasty = pod('karametra-haste');
    const aura = spawn(hasty, 'P1', card);
    const fast = spawn(
      hasty,
      'P1',
      oracle({
        name: 'Lab Hasty',
        typeLine: 'Creature — Secret',
        oracleText: 'Haste',
        keywords: ['Haste'],
      }),
      { summoningSick: true },
    );
    aura.attachedTo = fast.id;
    expect(castOption(hasty, 'P1', RED).option).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.09 Mask of Memory
// ---------------------------------------------------------------------------------------------

describe('Mask of Memory', () => {
  const { card } = pinned('Mask of Memory');
  const EQUIP = /: Equip \{1\}$/;
  const CREATURE = (name: string, power = '2', toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Secret', power, toughness });
  const SWORD = oracle({
    name: 'Lab Sword',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Equipped creature gets +1/+1.\nEquip {1}',
  });
  const QUICK = oracle({
    name: 'Lab Quick',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  /**
   * P1 controls the Mask (unattached), two 2/2 creatures and a Lab Sword; P2 controls a 2/2 and a
   * 0/4 wall. P1's hand holds one distinguishable card, so a discard has something to choose.
   */
  function board(seed: string) {
    const ctx = pod(seed);
    const mask = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', CREATURE('Lab First'));
    const second = spawn(ctx, 'P1', CREATURE('Lab Second'));
    const sword = spawn(ctx, 'P1', SWORD);
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const wall = spawn(ctx, 'P2', CREATURE('Lab Wall', '0', '4'));
    const keeper = conjure(ctx, 'P1', LAB_CARD('Lab Keeper'), 'hand');
    return { ctx, mask, first, second, sword, enemy, wall, keeper };
  }

  interface Run {
    /** Every "use this ability?" prompt the Mask put to P1. */
    asked: string[];
    /** The option descriptions of each discard prompt. */
    discards: string[][];
  }

  /**
   * Run P1's combat with `attackers` attacking P2. `blocks` maps a P2 blocker to the attacker it
   * blocks. The Mask's "may" is answered `accept`; its discard takes the card named `discard`.
   */
  function combat(
    ctx: GameContext,
    attackers: string[],
    opts: {
      accept?: boolean;
      discard?: string;
      blocks?: Map<string, string>;
      split?: Record<string, number>;
    } = {},
  ): Run {
    const run: Run = { asked: [], discards: [] };
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P2' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => opts.blocks?.get(subjectId) ?? null);
      if (decision.decisionType === 'assignCombatDamage' && opts.split !== undefined)
        return splitDamage(opts.split);
      if (/use this ability/.test(decision.prompt)) {
        run.asked.push(decision.prompt);
        const wanted = opts.accept === false ? 'declineTrigger' : 'acceptTrigger';
        return {
          index: decision.options.findIndex((option) => option.type === wanted),
          targets: new Map(),
        };
      }
      if (/^Discard a card/.test(decision.prompt)) {
        run.discards.push(decision.options.map((option) => option.description));
        const index = decision.options.findIndex(
          (option) => option.description === `Discard ${opts.discard ?? ''}`,
        );
        return { index: Math.max(index, 0), targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return run;
  }

  const names = (cards: { name: string }[]) => cards.map((c) => c.name).sort();
  const zones = (ctx: GameContext) => {
    const me = playerById(ctx, 'P1');
    return { hand: names(me.hand), graveyard: names(me.graveyard), library: me.library.length };
  };

  /** Put `ctx`'s Mask on `target` through Equip {1} on the real priority path. */
  function equip(ctx: GameContext, mask: EnginePermanent, target: EnginePermanent) {
    addMana(playerById(ctx, 'P1'), generic(1));
    const option = optionFor(ctx, 'P1', mask.id, EQUIP);
    expect(option, `Equip {1} onto ${target.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, target.id]]),
    );
    resolveTop(ctx);
  }

  it('mask-of-memory-pinned-oracle-supported — the interpreter alone models the equipped-creature trigger and Equip {1}', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    // Whenever equipped creature deals combat damage to a player, you may draw two cards.
    // If you do, discard a card: one optional trigger, the follow-up riding on the same yes.
    expect(trigger!.trigger).toEqual({
      when: 'dealsCombatDamageToPlayer',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
    expect(trigger!.optional).toBe(true);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'draw', count: { kind: 'const', n: 2 } },
      { op: 'discard', count: 1 },
    ]);
    // Equip {1}: sorcery speed (CR 702.6a), a creature you control, and nothing else.
    expect(def.activatedAbilities).toHaveLength(1);
    const [equipAbility] = def.activatedAbilities;
    expect(equipAbility!.timing).toBe('sorcery');
    expect(equipAbility!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(equipAbility!.ability.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(equipAbility!.ability.effects).toEqual([{ op: 'attachSelfTo', target: 0 }]);
    expect(def.staticEffects).toEqual([]);
  });

  it('mask-of-memory-draws-then-discards — accepting draws two, then you discard a card of your choice', () => {
    // Discard the card that was already in hand: both drawn Forests stay.
    const keep = board('mask-draw-keeper');
    keep.mask.attachedTo = keep.first.id;
    expect(zones(keep.ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });
    const kept = combat(keep.ctx, [keep.first.id], { discard: 'Lab Keeper' });
    expect(kept.asked).toHaveLength(1);
    // The draw comes first: the hand offered for the discard already holds both new cards.
    expect(kept.discards.map((options) => [...options].sort())).toEqual([
      ['Discard Forest', 'Discard Forest', 'Discard Lab Keeper'],
    ]);
    // Hand +1 (one card in, two drawn, one discarded), graveyard +1, library -2.
    expect(zones(keep.ctx)).toEqual({
      hand: ['Forest', 'Forest'],
      graveyard: ['Lab Keeper'],
      library: 6,
    });
    expect(playerById(keep.ctx, 'P2').life).toBe(38);

    // The discard is the player's choice: discarding a drawn Forest keeps Lab Keeper in hand.
    const swap = board('mask-draw-forest');
    swap.mask.attachedTo = swap.first.id;
    combat(swap.ctx, [swap.first.id], { discard: 'Forest' });
    expect(zones(swap.ctx)).toEqual({
      hand: ['Forest', 'Lab Keeper'],
      graveyard: ['Forest'],
      library: 6,
    });
  });

  it('mask-of-memory-decline — declining the optional trigger draws and discards nothing', () => {
    const { ctx, mask, first } = board('mask-decline');
    mask.attachedTo = first.id;
    const run = combat(ctx, [first.id], { accept: false });
    // It was offered, the creature still connected, and nothing moved between zones.
    expect(run.asked).toHaveLength(1);
    expect(run.discards).toEqual([]);
    expect(zones(ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });
    expect(playerById(ctx, 'P2').life).toBe(38);
  });

  it('mask-of-memory-only-this-equipments-creature — only the creature this Mask is attached to triggers it, and moving the Mask moves that', () => {
    // Unattached: nothing triggers it.
    const bare = board('mask-bare');
    expect(combat(bare.ctx, [bare.first.id, bare.second.id]).asked).toEqual([]);
    expect(zones(bare.ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });

    // Attached to First: an unequipped creature dealing combat damage beside it adds no prompt,
    // and attacking with only the unequipped creature asks nothing.
    const both = board('mask-both');
    both.mask.attachedTo = both.first.id;
    expect(combat(both.ctx, [both.first.id, both.second.id]).asked).toHaveLength(1);
    const alone = board('mask-alone');
    alone.mask.attachedTo = alone.first.id;
    expect(combat(alone.ctx, [alone.second.id]).asked).toEqual([]);
    expect(zones(alone.ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });

    // A creature carrying a different Equipment is not "equipped creature" for this Mask.
    const other = board('mask-other-equipment');
    other.mask.attachedTo = other.first.id;
    other.sword.attachedTo = other.second.id;
    expect(combat(other.ctx, [other.second.id]).asked).toEqual([]);
    expect(zones(other.ctx).library).toBe(8);

    // Moving the Mask (Equip {1}) moves which creature triggers it: it follows to Second ...
    const moved = board('mask-moved');
    moved.mask.attachedTo = moved.first.id;
    equip(moved.ctx, moved.mask, moved.second);
    expect(moved.mask.attachedTo).toBe(moved.second.id);
    const afterMove = combat(moved.ctx, [moved.first.id, moved.second.id]);
    expect(afterMove.asked).toHaveLength(1);
    expect(zones(moved.ctx).library).toBe(6);
    // ... and First, which no longer carries it, does not trigger it on its own.
    const left = board('mask-left');
    left.mask.attachedTo = left.first.id;
    equip(left.ctx, left.mask, left.second);
    expect(combat(left.ctx, [left.first.id]).asked).toEqual([]);
    expect(zones(left.ctx).library).toBe(8);
  });

  it('mask-of-memory-not-to-creatures — combat damage dealt only to a blocking creature does not trigger it', () => {
    // Blocked by the wall: all the damage goes to the creature, none to a player.
    const blocked = board('mask-blocked');
    blocked.mask.attachedTo = blocked.first.id;
    const run = combat(blocked.ctx, [blocked.first.id], {
      blocks: new Map([[blocked.wall.id, blocked.first.id]]),
    });
    expect(run.asked).toEqual([]);
    expect(zones(blocked.ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });
    expect(playerById(blocked.ctx, 'P2').life).toBe(40);

    // The same attack unblocked does connect and does trigger it.
    const open = board('mask-unblocked');
    open.mask.attachedTo = open.first.id;
    expect(combat(open.ctx, [open.first.id]).asked).toHaveLength(1);

    // A blocker on a different attacker leaves the equipped creature unblocked: it triggers.
    const elsewhere = board('mask-block-other');
    elsewhere.mask.attachedTo = elsewhere.first.id;
    const beside = combat(elsewhere.ctx, [elsewhere.first.id, elsewhere.second.id], {
      blocks: new Map([[elsewhere.wall.id, elsewhere.second.id]]),
    });
    expect(beside.asked).toHaveLength(1);
    expect(playerById(elsewhere.ctx, 'P2').life).toBe(38);

    // Trample is combat damage to a player too: the part assigned past the blocker triggers it.
    const trample = board('mask-trample');
    const trampler = spawn(
      trample.ctx,
      'P1',
      oracle({
        name: 'Lab Trampler',
        typeLine: 'Creature — Secret',
        power: '4',
        toughness: '4',
        oracleText: 'Trample',
      }),
    );
    trample.mask.attachedTo = trampler.id;
    const through = combat(trample.ctx, [trampler.id], {
      blocks: new Map([[trample.enemy.id, trampler.id]]),
      split: { [trample.enemy.id]: 2, P2: 2 },
    });
    expect(through.asked).toHaveLength(1);
    expect(playerById(trample.ctx, 'P2').life).toBe(38);
  });

  it('mask-of-memory-not-noncombat — damage to a player outside combat does not trigger it', () => {
    const PINGER = oracle({
      name: 'Lab Pinger',
      typeLine: 'Creature — Secret',
      power: '1',
      toughness: '1',
      oracleText: '{T}: Lab Pinger deals 1 damage to any target.',
    });
    const { ctx, mask } = board('mask-noncombat');
    const pinger = spawn(ctx, 'P1', PINGER);
    mask.attachedTo = pinger.id;
    const ping = optionFor(ctx, 'P1', pinger.id);
    expect(ping, 'the equipped creature pings').toBeDefined();
    takeAction(
      ctx,
      'P1',
      ping!.payload as PriorityActionPayload,
      undefined,
      new Map([[ping!.targets![0]!.slot, 'P2']]),
    );
    resolveTop(ctx, (decision) => {
      if (/use this ability/.test(decision.prompt))
        throw new Error(`noncombat damage triggered the Mask: ${decision.prompt}`);
      return { index: 0, targets: new Map() };
    });
    // The equipped creature did deal damage to a player — just not combat damage.
    expect(playerById(ctx, 'P2').life).toBe(39);
    expect(ctx.state.stack).toHaveLength(0);
    expect(zones(ctx)).toEqual({ hand: ['Lab Keeper'], graveyard: [], library: 8 });

    // Combat damage from the same creature still triggers it.
    const fight = board('mask-noncombat-combat');
    const hitter = spawn(fight.ctx, 'P1', PINGER);
    fight.mask.attachedTo = hitter.id;
    expect(combat(fight.ctx, [hitter.id]).asked).toHaveLength(1);
  });

  it('mask-of-memory-equip-sorcery — Equip {1} is offered only at sorcery speed, only onto a creature you control', () => {
    const { ctx, mask, first, second, enemy } = board('mask-equip');
    const targetNames = (option: NonNullable<ReturnType<typeof optionFor>>) => {
      const nameOf = (id: string) =>
        ctx.state.battlefield.find((perm) => perm.id === id)?.name ?? id;
      return option.targets!.flatMap((slot) => slot.options.map(nameOf)).sort();
    };

    // Without {1} it cannot be activated.
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeUndefined();

    // Your main phase, empty stack: offered, and only your creatures are legal targets.
    addMana(playerById(ctx, 'P1'), generic(2));
    const main = optionFor(ctx, 'P1', mask.id, EQUIP);
    expect(main).toBeDefined();
    expect(targetNames(main!)).toEqual(['Lab First', 'Lab Second']);
    expect(targetNames(main!)).not.toContain(enemy.name);

    // A spell on the stack: not offered, though the mana is there.
    castFromHand(ctx, 'P1', QUICK, []);
    expect(ctx.state.stack).toHaveLength(1);
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeUndefined();
    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeDefined();

    // An opponent's turn, and a non-main phase of your own turn: not offered.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeUndefined();
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeUndefined();
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    expect(optionFor(ctx, 'P1', mask.id, EQUIP)).toBeDefined();

    // Activating it puts it on the stack; resolving attaches the Mask to the chosen creature.
    const option = optionFor(ctx, 'P1', mask.id, EQUIP)!;
    takeAction(
      ctx,
      'P1',
      option.payload as PriorityActionPayload,
      undefined,
      new Map([[option.targets![0]!.slot, second.id]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(mask.attachedTo ?? null).toBeNull();
    resolveTop(ctx);
    expect(mask.attachedTo).toBe(second.id);
    expect(mask.attachedTo).not.toBe(first.id);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.10 Redemption Arc
// ---------------------------------------------------------------------------------------------

describe('Redemption Arc', () => {
  const { card } = pinned('Redemption Arc');
  const EXILE = /Exile enchanted creature/;
  const CREATURE = (name: string, text = '') =>
    oracle({ name, typeLine: 'Creature — Secret', oracleText: text });
  const SMITE = oracle({
    name: 'Lab Smite',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'Destroy target creature.',
  });
  const BLAST = oracle({
    name: 'Lab Blast',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'Lab Blast deals 5 damage to target creature.',
  });
  const COST = [{ symbol: 'W' as const }, ...generic(1)];

  /** P1 controls Redemption Arc on Lab Host and Lab Other; P2 controls Lab Enemy and Lab Wall. */
  function board(seed: string) {
    const ctx = pod(seed);
    const aura = spawn(ctx, 'P1', card);
    const host = spawn(ctx, 'P1', CREATURE('Lab Host'));
    const other = spawn(ctx, 'P1', CREATURE('Lab Other'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const wall = spawn(ctx, 'P2', CREATURE('Lab Wall'));
    aura.attachedTo = host.id;
    return { ctx, aura, host, other, enemy, wall };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const alive = (ctx: GameContext, perm: EnginePermanent) => ctx.state.battlefield.includes(perm);
  const goaded = (ctx: GameContext, perm: EnginePermanent) =>
    computeCharacteristics(ctx, perm).staticGoadedBy ?? [];

  /** P1 casts an instant at `targetId` through the normal path and lets it resolve. */
  function castAt(ctx: GameContext, spell: OracleCard, targetId: string) {
    const object = conjure(ctx, 'P1', spell, 'hand');
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, `P1 casts ${spell.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    resolveTop(ctx);
    return settle(ctx);
  }

  /** The attack declaration `P2` is offered on its own turn, as the engine presents it. */
  function p2AttackSubjects(ctx: GameContext) {
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const seen: { name: string; mustAttack: boolean; defenders: string[] }[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        for (const subject of decision.presentationAttackDeclaration.subjects)
          seen.push({
            name: subject.name,
            mustAttack: subject.mustAttack,
            defenders: subject.defenders.map((defender) => defender.playerId),
          });
        return declareAttacks(decision, (_id, subject) =>
          subject.mustAttack ? (subject.defenders[0]?.playerId ?? null) : null,
        );
      }
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return seen;
  }

  it('redemption-arc-pinned-oracle-supported — the interpreter alone models the granted indestructible and goad and the untargeted exile activation', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.spellAbility?.effects).toEqual([]);
    expect(def.triggers).toEqual([]);
    // Indestructible and goaded: two layer 6 grants on the creature this Aura is attached to.
    expect(def.staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'indestructible' } },
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addGoad: true } },
    ]);
    // {1}{W}: Exile enchanted creature. At instant speed, with no target.
    expect(def.activatedAbilities).toHaveLength(1);
    const [exile] = def.activatedAbilities;
    expect(exile!.timing).toBe('any');
    expect(exile!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 1, colored: { W: 1, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(exile!.ability.targets).toEqual([]);
    expect(exile!.ability.effects).toEqual([{ op: 'exile', target: 'attachedToSource' }]);
  });

  it('redemption-arc-indestructible-enchanted-only — only the enchanted creature is indestructible: it survives destroy and lethal damage, nothing else does', () => {
    const { ctx, aura, host, other, enemy } = board('redemption-indestructible');
    expect(hasKeyword(ctx, host, 'indestructible')).toBe(true);
    expect(hasKeyword(ctx, other, 'indestructible')).toBe(false);
    expect(hasKeyword(ctx, enemy, 'indestructible')).toBe(false);
    castAt(ctx, SMITE, host.id);
    expect(alive(ctx, host)).toBe(true);
    castAt(ctx, BLAST, host.id);
    expect(alive(ctx, host)).toBe(true);

    // The same spells kill creatures it is not on.
    castAt(ctx, SMITE, other.id);
    expect(alive(ctx, other)).toBe(false);
    castAt(ctx, BLAST, enemy.id);
    expect(alive(ctx, enemy)).toBe(false);

    // Moved to an opponent's creature, it follows; unattached, nothing is indestructible.
    const wall = named(ctx, 'Lab Wall')[0]!;
    aura.attachedTo = wall.id;
    expect(hasKeyword(ctx, wall, 'indestructible')).toBe(true);
    expect(hasKeyword(ctx, host, 'indestructible')).toBe(false);
    aura.attachedTo = null;
    expect(hasKeyword(ctx, wall, 'indestructible')).toBe(false);
    castAt(ctx, SMITE, host.id);
    expect(alive(ctx, host)).toBe(false);
  });

  it("redemption-arc-goaded — the enchanted creature is goaded by the Aura's controller: it must attack and attacks a player other than them; unenchanted creatures are free", () => {
    const { ctx, aura, host, other, enemy } = board('redemption-goad');
    expect(goaded(ctx, host)).toEqual(['P1']);
    for (const perm of [other, enemy]) expect(goaded(ctx, perm)).toEqual([]);

    // P2's creature enchanted by P1's Aura must attack, and never P1 while P3 or P4 can be.
    aura.attachedTo = enemy.id;
    const seen = p2AttackSubjects(ctx);
    const forced = seen.find((subject) => subject.name === 'Lab Enemy');
    expect(forced?.mustAttack).toBe(true);
    expect(forced?.defenders.sort()).toEqual(['P3', 'P4']);
    const free = seen.find((subject) => subject.name === 'Lab Wall');
    expect(free?.mustAttack).toBe(false);
    expect(free?.defenders.sort()).toEqual(['P1', 'P3', 'P4']);
    expect(playerById(ctx, 'P1').life).toBe(40);
    // Lab Enemy is a 2/2 and really attacked: one of P3 or P4 took 2, P1 took nothing.
    expect(playerById(ctx, 'P3').life + playerById(ctx, 'P4').life).toBe(78);

    // Unattached, the Aura goads nobody.
    const bare = board('redemption-goad-bare');
    bare.aura.attachedTo = null;
    expect(p2AttackSubjects(bare.ctx).every((subject) => !subject.mustAttack)).toBe(true);
  });

  it('redemption-arc-exile-untargeted — {1}{W} exiles the enchanted creature without targeting, even a hexproof or indestructible one', () => {
    const { ctx, aura, host, other } = board('redemption-exile');
    addMana(playerById(ctx, 'P1'), COST);
    const option = optionFor(ctx, 'P1', aura.id, EXILE);
    expect(option).toBeDefined();
    // No target is asked for, and none is chosen.
    expect(option!.targets ?? []).toEqual([]);
    const { decisions } = takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(decisions.filter((decision) => /target/i.test(decision.prompt))).toEqual([]);
    expect(ctx.state.stack).toHaveLength(1);
    // The ability is on the stack; nothing has happened to the creature yet, and the mana is spent.
    expect(alive(ctx, host)).toBe(true);
    resolveTop(ctx);
    settle(ctx);
    // Indestructible does not stop exile: the card is in exile, not the graveyard.
    expect(alive(ctx, host)).toBe(false);
    expect(ctx.state.exile.map((c) => c.name)).toEqual(['Lab Host']);
    expect(playerById(ctx, 'P1').graveyard.map((c) => c.name)).toEqual(['Redemption Arc']);
    // Only the enchanted creature went.
    expect(alive(ctx, other)).toBe(true);

    // A hexproof creature of an opponent's is exiled the same way: nothing is targeted.
    const hexproof = board('redemption-exile-hexproof');
    const shielded = spawn(
      hexproof.ctx,
      'P2',
      oracle({
        name: 'Lab Hexproof Elf',
        typeLine: 'Creature — Elf',
        oracleText: 'Hexproof',
        keywords: ['Hexproof'],
      }),
    );
    hexproof.aura.attachedTo = shielded.id;
    addMana(playerById(hexproof.ctx, 'P1'), COST);
    const again = optionFor(hexproof.ctx, 'P1', hexproof.aura.id, EXILE);
    expect(again).toBeDefined();
    takeAction(hexproof.ctx, 'P1', again!.payload as PriorityActionPayload);
    resolveTop(hexproof.ctx);
    settle(hexproof.ctx);
    expect(alive(hexproof.ctx, shielded)).toBe(false);
    expect(playerById(hexproof.ctx, 'P2').graveyard).toEqual([]);
    expect(hexproof.ctx.state.exile.map((c) => c.name)).toEqual(['Lab Hexproof Elf']);
    expect(hexproof.ctx.state.stack).toEqual([]);
  });

  it('redemption-arc-activation-controller-mana — only the Aura’s controller can activate it, and only with {1}{W}', () => {
    const { ctx, aura } = board('redemption-activation');
    // No mana, then too little mana: not offered.
    expect(optionFor(ctx, 'P1', aura.id, EXILE)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }]);
    expect(optionFor(ctx, 'P1', aura.id, EXILE)).toBeUndefined();
    // Two mana but no white: not offered.
    const colorless = board('redemption-activation-colorless');
    addMana(playerById(colorless.ctx, 'P1'), generic(2));
    expect(optionFor(colorless.ctx, 'P1', colorless.aura.id, EXILE)).toBeUndefined();
    // {1}{W}: offered, at instant speed even on an opponent's turn.
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(optionFor(ctx, 'P1', aura.id, EXILE)).toBeDefined();
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(optionFor(ctx, 'P1', aura.id, EXILE)).toBeDefined();

    // The creature's controller is not the Aura's: P2 enchanted by P1's Aura cannot exile it, and
    // activating it as P1 exiles P2's creature.
    const theirs = board('redemption-activation-opponent');
    theirs.aura.attachedTo = theirs.enemy.id;
    addMana(playerById(theirs.ctx, 'P2'), COST);
    expect(optionFor(theirs.ctx, 'P2', theirs.aura.id, EXILE)).toBeUndefined();
    addMana(playerById(theirs.ctx, 'P1'), COST);
    const option = optionFor(theirs.ctx, 'P1', theirs.aura.id, EXILE);
    expect(option).toBeDefined();
    takeAction(theirs.ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(theirs.ctx);
    settle(theirs.ctx);
    expect(alive(theirs.ctx, theirs.enemy)).toBe(false);
    expect(theirs.ctx.state.exile.map((c) => c.name)).toEqual(['Lab Enemy']);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.11 Resurrection Orb
// ---------------------------------------------------------------------------------------------

describe('Resurrection Orb', () => {
  const { card } = pinned('Resurrection Orb');
  const EQUIP = /: Equip \{4\}$/;
  const CREATURE = (name: string, power = '2', toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Secret', power, toughness });
  const SWORD = oracle({
    name: 'Lab Sword',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Equipped creature gets +1/+1.\nEquip {1}',
  });
  const QUICK = oracle({
    name: 'Lab Quick',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  /**
   * P1 controls the Orb (unattached), two 2/2 creatures and a Lab Sword; P2 controls a 2/2 and a
   * 3/3. Everything is already on the battlefield, so nothing here is summoning sick.
   */
  function board(seed: string) {
    const ctx = pod(seed);
    const orb = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', CREATURE('Lab First'));
    const second = spawn(ctx, 'P1', CREATURE('Lab Second'));
    const sword = spawn(ctx, 'P1', SWORD);
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const brute = spawn(ctx, 'P2', CREATURE('Lab Brute', '3', '3'));
    return { ctx, orb, first, second, sword, enemy, brute };
  }

  /** Run P1's combat with `attackers` attacking P2; `blocks` maps a P2 blocker to its attacker. */
  function combat(ctx: GameContext, attackers: string[], blocks = new Map<string, string>()) {
    return pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (subjectId) =>
          attackers.includes(subjectId) ? 'P2' : null,
        );
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, (subjectId) => blocks.get(subjectId) ?? null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
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

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const graveyardOf = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);
  const life = (ctx: GameContext, playerId: string) => playerById(ctx, playerId).life;

  /** Put the Orb on `target` through Equip {4} on the real priority path. */
  function equip(ctx: GameContext, orb: EnginePermanent, target: EnginePermanent) {
    addMana(playerById(ctx, 'P1'), generic(4));
    const option = optionFor(ctx, 'P1', orb.id, EQUIP);
    expect(option, `Equip {4} onto ${target.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, target.id]]),
    );
    resolveTop(ctx);
    expect(orb.attachedTo).toBe(target.id);
  }

  /** The card `name` currently in `playerId`'s graveyard. */
  function inGraveyard(ctx: GameContext, playerId: string, name: string) {
    const found = playerById(ctx, playerId).graveyard.find((c) => c.name === name);
    expect(found, `${name} in ${playerId}'s graveyard`).toBeDefined();
    return found!;
  }

  it('resurrection-orb-pinned-oracle-supported — the interpreter alone models the lifelink grant, the dies return and Equip {4}', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Equipped creature has lifelink: a layer 6 keyword grant to the attached creature only.
    expect(def.staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'lifelink' } },
    ]);
    // Whenever equipped creature dies, return that card ... at the beginning of the next end step.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'dies',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'returnDiedTriggerObjectAtNextEndStep', returnUnder: 'owner' },
    ]);
    // Equip {4}: sorcery speed (CR 702.6a), a creature you control, and nothing else.
    expect(def.activatedAbilities).toHaveLength(1);
    const [equipAbility] = def.activatedAbilities;
    expect(equipAbility!.timing).toBe('sorcery');
    expect(equipAbility!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 4, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(equipAbility!.ability.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(equipAbility!.ability.effects).toEqual([{ op: 'attachSelfTo', target: 0 }]);
  });

  it('resurrection-orb-lifelink-equipped-only — the equipped creature has lifelink and gains you life; no other creature does', () => {
    // Attached to First: First has lifelink, Second does not, and only First's damage gains life.
    const both = board('orb-lifelink');
    both.orb.attachedTo = both.first.id;
    expect(hasKeyword(both.ctx, both.first, 'lifelink')).toBe(true);
    expect(hasKeyword(both.ctx, both.second, 'lifelink')).toBe(false);
    expect(hasKeyword(both.ctx, both.enemy, 'lifelink')).toBe(false);
    combat(both.ctx, [both.first.id, both.second.id]);
    expect(life(both.ctx, 'P2')).toBe(36);
    expect(life(both.ctx, 'P1')).toBe(42);

    // The unequipped creature alone connects: no life is gained.
    const alone = board('orb-lifelink-alone');
    alone.orb.attachedTo = alone.first.id;
    combat(alone.ctx, [alone.second.id]);
    expect(life(alone.ctx, 'P2')).toBe(38);
    expect(life(alone.ctx, 'P1')).toBe(40);

    // Unattached, the Orb grants lifelink to nobody.
    const bare = board('orb-lifelink-bare');
    expect(hasKeyword(bare.ctx, bare.first, 'lifelink')).toBe(false);
    combat(bare.ctx, [bare.first.id, bare.second.id]);
    expect(life(bare.ctx, 'P1')).toBe(40);

    // A creature carrying a different Equipment does not get it from this Orb.
    const other = board('orb-lifelink-other-equipment');
    other.orb.attachedTo = other.first.id;
    other.sword.attachedTo = other.second.id;
    expect(hasKeyword(other.ctx, other.second, 'lifelink')).toBe(false);

    // Moving the Orb (Equip {4}) moves the keyword: Second gains it and First loses it.
    const moved = board('orb-lifelink-moved');
    moved.orb.attachedTo = moved.first.id;
    equip(moved.ctx, moved.orb, moved.second);
    expect(hasKeyword(moved.ctx, moved.second, 'lifelink')).toBe(true);
    expect(hasKeyword(moved.ctx, moved.first, 'lifelink')).toBe(false);
    combat(moved.ctx, [moved.first.id]);
    expect(life(moved.ctx, 'P1')).toBe(40);
  });

  it('resurrection-orb-dies-trigger-equipped-only — only the creature this Orb is attached to dying sets up the return', () => {
    // The equipped creature dies: exactly one delayed return is set up.
    const hit = board('orb-dies');
    hit.orb.attachedTo = hit.first.id;
    pump(moveObject(hit.ctx, hit.first, { zone: 'graveyard' }));
    settle(hit.ctx);
    expect(hit.ctx.state.delayedTriggers).toHaveLength(1);
    expect(hit.ctx.state.delayedTriggers[0]!.when).toBe('endStep');
    expect(graveyardOf(hit.ctx, 'P1')).toEqual(['Lab First']);

    // An unequipped creature of yours dying beside it sets up nothing.
    const beside = board('orb-dies-other');
    beside.orb.attachedTo = beside.first.id;
    pump(moveObject(beside.ctx, beside.second, { zone: 'graveyard' }));
    settle(beside.ctx);
    expect(beside.ctx.state.delayedTriggers).toEqual([]);
    beginEndStep(beside.ctx);
    settle(beside.ctx);
    expect(named(beside.ctx, 'Lab Second')).toEqual([]);
    expect(graveyardOf(beside.ctx, 'P1')).toEqual(['Lab Second']);

    // Unattached, the Orb returns nothing when a creature dies.
    const bare = board('orb-dies-bare');
    pump(moveObject(bare.ctx, bare.first, { zone: 'graveyard' }));
    settle(bare.ctx);
    expect(bare.ctx.state.delayedTriggers).toEqual([]);

    // A creature carrying a different Equipment dying is not "equipped creature" for this Orb.
    const sword = board('orb-dies-other-equipment');
    sword.orb.attachedTo = sword.first.id;
    sword.sword.attachedTo = sword.second.id;
    pump(moveObject(sword.ctx, sword.second, { zone: 'graveyard' }));
    settle(sword.ctx);
    expect(sword.ctx.state.delayedTriggers).toEqual([]);

    // Once the Orb moves, the creature it left no longer sets anything up; the new one does.
    const moved = board('orb-dies-moved');
    moved.orb.attachedTo = moved.first.id;
    equip(moved.ctx, moved.orb, moved.second);
    pump(moveObject(moved.ctx, moved.first, { zone: 'graveyard' }));
    settle(moved.ctx);
    expect(moved.ctx.state.delayedTriggers).toEqual([]);
    pump(moveObject(moved.ctx, moved.second, { zone: 'graveyard' }));
    settle(moved.ctx);
    expect(moved.ctx.state.delayedTriggers).toHaveLength(1);

    // Leaving the battlefield any way but dying (exile, bounce) sets up nothing.
    const exiled = board('orb-exiled');
    exiled.orb.attachedTo = exiled.first.id;
    pump(moveObject(exiled.ctx, exiled.first, { zone: 'exile' }));
    settle(exiled.ctx);
    expect(exiled.ctx.state.delayedTriggers).toEqual([]);
    const bounced = board('orb-bounced');
    bounced.orb.attachedTo = bounced.first.id;
    pump(moveObject(bounced.ctx, bounced.first, { zone: 'hand' }));
    settle(bounced.ctx);
    expect(bounced.ctx.state.delayedTriggers).toEqual([]);
  });

  it('resurrection-orb-next-end-step — dying in combat returns it at the end step, not before; the delayed trigger is spent once it fires', () => {
    const { ctx, orb, first, second, brute } = board('orb-combat');
    orb.attachedTo = first.id;
    // The 3/3 blocks and kills the equipped 2/2 in real combat.
    combat(ctx, [first.id, second.id], new Map([[brute.id, first.id]]));
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab First']);
    expect(named(ctx, 'Lab First')).toEqual([]);
    // Lifelink was real: First dealt 2 damage to the blocker before dying, Second hit the player.
    expect(life(ctx, 'P1')).toBe(42);
    expect(life(ctx, 'P2')).toBe(38);
    // The Orb is no longer attached to anything.
    expect(orb.attachedTo ?? null).toBeNull();

    // The return waits: one delayed trigger that lasts until it fires (past cleanup), no more.
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]!.when).toBe('endStep');
    expect(ctx.state.delayedTriggers[0]!.expiry).toBe('onFire');
    // Not immediately: further priority passes and non-end steps return nothing.
    settle(ctx);
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    settle(ctx);
    expect(named(ctx, 'Lab First')).toEqual([]);
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab First']);

    // The beginning of the end step: the trigger goes on the stack, and it returns when it resolves.
    beginEndStep(ctx);
    expect(named(ctx, 'Lab First')).toEqual([]);
    settle(ctx);
    const [back] = named(ctx, 'Lab First');
    expect(back?.controllerId).toBe('P1');
    expect(back?.id).not.toBe(first.id);
    expect(graveyardOf(ctx, 'P1')).toEqual([]);
    expect(ctx.state.delayedTriggers).toEqual([]);
    // It comes back as a new object: the Orb is not attached to it and it has no lifelink.
    expect(orb.attachedTo ?? null).toBeNull();
    expect(hasKeyword(ctx, back!, 'lifelink')).toBe(false);

    // Spent: dying again (no longer equipped) and a later end step bring nothing back.
    pump(moveObject(ctx, back!, { zone: 'graveyard' }));
    settle(ctx);
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab First')).toEqual([]);
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab First']);
  });

  it("resurrection-orb-next-end-step-any-turn — an end step that already began is not the next one; the return waits through cleanup for the following end step, whoever's turn it is", () => {
    // Dying during this turn's end step: that end step has begun, so it does not return then.
    const ctx = pod('orb-in-end-step');
    const orb = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', CREATURE('Lab First'));
    orb.attachedTo = first.id;
    beginEndStep(ctx);
    settle(ctx);
    pump(moveObject(ctx, first, { zone: 'graveyard' }));
    settle(ctx);
    expect(named(ctx, 'Lab First')).toEqual([]);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    expect(ctx.state.delayedTriggers[0]!.expiry).toBe('onFire');

    // P2's whole turn runs: cleanup of this turn does not sweep it, and it returns at P2's end step
    // (the next end step to begin, though it is not P1's), under P1's control as P1 owns it.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    quietTurn(ctx);
    const [back] = named(ctx, 'Lab First');
    expect(back?.controllerId).toBe('P1');
    expect(ctx.state.delayedTriggers).toEqual([]);

    // Dying during an opponent's turn returns it at the end of that same turn.
    const theirs = board('orb-opponents-turn');
    theirs.ctx.state.currentTurnPlayer = 'P2';
    theirs.ctx.state.activePlayerIndex = 1;
    theirs.orb.attachedTo = theirs.first.id;
    pump(moveObject(theirs.ctx, theirs.first, { zone: 'graveyard' }));
    settle(theirs.ctx);
    expect(named(theirs.ctx, 'Lab First')).toEqual([]);
    beginEndStep(theirs.ctx);
    settle(theirs.ctx);
    expect(named(theirs.ctx, 'Lab First')).toHaveLength(1);
  });

  it("resurrection-orb-returns-under-owner — a creature you control but an opponent owns returns under its owner's control, not yours", () => {
    const { ctx, orb, first } = board('orb-owner');
    // P1 controls a creature P2 owns, and equips it through Equip {4}.
    const stolen = spawn(ctx, 'P2', CREATURE('Lab Stolen'));
    stolen.controllerId = 'P1';
    equip(ctx, orb, stolen);
    pump(moveObject(ctx, stolen, { zone: 'graveyard' }));
    settle(ctx);
    // It died into its owner's graveyard, and waits there.
    expect(graveyardOf(ctx, 'P2')).toEqual(['Lab Stolen']);
    expect(graveyardOf(ctx, 'P1')).toEqual([]);
    beginEndStep(ctx);
    settle(ctx);
    const [back] = named(ctx, 'Lab Stolen');
    expect(back?.ownerId).toBe('P2');
    expect(back?.controllerId).toBe('P2');
    expect(graveyardOf(ctx, 'P2')).toEqual([]);
    expect(
      ctx.state.battlefield.filter((p) => p.controllerId === 'P1' && p.name === 'Lab Stolen'),
    ).toEqual([]);

    // A creature you own and control returns under your control.
    orb.attachedTo = first.id;
    pump(moveObject(ctx, first, { zone: 'graveyard' }));
    settle(ctx);
    beginEndStep(ctx);
    settle(ctx);
    expect(named(ctx, 'Lab First')[0]?.controllerId).toBe('P1');
  });

  it('resurrection-orb-card-left-graveyard — a card that left the graveyard before the end step stays where it went (CR 400.7)', () => {
    const died = (seed: string) => {
      const b = board(seed);
      b.orb.attachedTo = b.first.id;
      pump(moveObject(b.ctx, b.first, { zone: 'graveyard' }));
      settle(b.ctx);
      expect(b.ctx.state.delayedTriggers).toHaveLength(1);
      return b;
    };

    // Control: untouched in the graveyard, it returns.
    const control = died('orb-left-control');
    beginEndStep(control.ctx);
    settle(control.ctx);
    expect(named(control.ctx, 'Lab First')).toHaveLength(1);

    // Exiled from the graveyard first: it stays in exile.
    const exiled = died('orb-left-exile');
    pump(moveObject(exiled.ctx, inGraveyard(exiled.ctx, 'P1', 'Lab First'), { zone: 'exile' }));
    beginEndStep(exiled.ctx);
    settle(exiled.ctx);
    expect(named(exiled.ctx, 'Lab First')).toEqual([]);
    expect(exiled.ctx.state.exile.map((c) => c.name)).toEqual(['Lab First']);
    expect(exiled.ctx.state.delayedTriggers).toEqual([]);

    // Returned to its owner's hand first: it stays in hand.
    const hand = died('orb-left-hand');
    pump(moveObject(hand.ctx, inGraveyard(hand.ctx, 'P1', 'Lab First'), { zone: 'hand' }));
    beginEndStep(hand.ctx);
    settle(hand.ctx);
    expect(named(hand.ctx, 'Lab First')).toEqual([]);
    expect(playerById(hand.ctx, 'P1').hand.map((c) => c.name)).toEqual(['Lab First']);

    // Left and came back as a new object: that is not the card the trigger remembers.
    const again = died('orb-left-and-back');
    pump(moveObject(again.ctx, inGraveyard(again.ctx, 'P1', 'Lab First'), { zone: 'hand' }));
    pump(moveObject(again.ctx, playerById(again.ctx, 'P1').hand[0]!, { zone: 'graveyard' }));
    expect(graveyardOf(again.ctx, 'P1')).toEqual(['Lab First']);
    beginEndStep(again.ctx);
    settle(again.ctx);
    expect(named(again.ctx, 'Lab First')).toEqual([]);
    expect(graveyardOf(again.ctx, 'P1')).toEqual(['Lab First']);

    // A token that dies ceases to exist, so there is no card to return.
    const token = board('orb-left-token');
    const dying = spawn(token.ctx, 'P1', CREATURE('Lab Token'), { isToken: true });
    token.orb.attachedTo = dying.id;
    pump(moveObject(token.ctx, dying, { zone: 'graveyard' }));
    settle(token.ctx);
    beginEndStep(token.ctx);
    settle(token.ctx);
    expect(named(token.ctx, 'Lab Token')).toEqual([]);
    expect(token.ctx.state.delayedTriggers).toEqual([]);
  });

  it('resurrection-orb-equip-sorcery — Equip {4} is offered only at sorcery speed, only onto a creature you control', () => {
    const { ctx, orb, first, second, enemy } = board('orb-equip');
    const targetNames = (option: NonNullable<ReturnType<typeof optionFor>>) => {
      const nameOf = (id: string) =>
        ctx.state.battlefield.find((perm) => perm.id === id)?.name ?? id;
      return option.targets!.flatMap((slot) => slot.options.map(nameOf)).sort();
    };

    // Without {4} (three mana) it cannot be activated.
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeUndefined();

    // Your main phase, empty stack, {4} available: offered, and only your creatures are legal.
    addMana(playerById(ctx, 'P1'), generic(1));
    const main = optionFor(ctx, 'P1', orb.id, EQUIP);
    expect(main).toBeDefined();
    expect(targetNames(main!)).toEqual(['Lab First', 'Lab Second']);
    expect(targetNames(main!)).not.toContain(enemy.name);

    // A spell on the stack: not offered, though the mana is there.
    castFromHand(ctx, 'P1', QUICK, []);
    expect(ctx.state.stack).toHaveLength(1);
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeUndefined();
    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeDefined();

    // An opponent's turn, and a non-main phase of your own turn: not offered.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeUndefined();
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeUndefined();
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeDefined();

    // Activating it puts it on the stack; resolving attaches the Orb to the chosen creature and
    // spends all four mana.
    const option = optionFor(ctx, 'P1', orb.id, EQUIP)!;
    takeAction(
      ctx,
      'P1',
      option.payload as PriorityActionPayload,
      undefined,
      new Map([[option.targets![0]!.slot, second.id]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(orb.attachedTo ?? null).toBeNull();
    resolveTop(ctx);
    expect(orb.attachedTo).toBe(second.id);
    expect(orb.attachedTo).not.toBe(first.id);
    expect(optionFor(ctx, 'P1', orb.id, EQUIP)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.12 Screams from Within
// ---------------------------------------------------------------------------------------------

describe('Screams from Within', () => {
  const { card } = pinned('Screams from Within');
  const CREATURE = (name: string, power = '2', toughness = '2') =>
    oracle({ name, typeLine: 'Creature — Secret', power, toughness });
  const HEXPROOF = oracle({
    name: 'Lab Hexproof',
    typeLine: 'Creature — Secret',
    power: '2',
    toughness: '2',
    oracleText: 'Hexproof',
    keywords: ['Hexproof'],
  });
  const RESPONSE = oracle({
    name: 'Lab Response',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });
  const SCREAMS_MANA = [{ symbol: 'B' as const }, { symbol: 'B' as const }, ...generic(1)];

  /**
   * P1 controls Screams enchanting Lab Bear, plus Lab Ally; P2 controls Lab Enemy and a hexproof
   * creature. Everything is already on the battlefield.
   */
  function board(seed: string) {
    const ctx = pod(seed);
    const screams = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const ally = spawn(ctx, 'P1', CREATURE('Lab Ally'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const hexproof = spawn(ctx, 'P2', HEXPROOF);
    screams.attachedTo = bear.id;
    return { ctx, screams, bear, ally, enemy, hexproof };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const graveyardOf = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);

  /** An answer that picks the Aura host by name and records every host choice offered. */
  function chooseHost(name: string | null, offered: string[][] = []): Answer {
    return (decision) => {
      const hosts = decision.options.filter((option) => option.type === 'attachAura');
      if (hosts.length === 0) return { index: 0, targets: new Map() };
      offered.push(hosts.map((option) => option.description.replace(/^Enchant /, '')));
      const index = hosts.findIndex((option) => option.description === `Enchant ${name}`);
      return { index: decision.options.indexOf(hosts[Math.max(index, 0)]!), targets: new Map() };
    };
  }

  /**
   * Kill `perm`, then run the priority loop; the first time a player holds priority with the
   * trigger on the stack, `meanwhile` runs (state changes made in response to it).
   */
  function dieThenRespond(
    ctx: GameContext,
    perm: EnginePermanent,
    meanwhile: () => void,
    name: string | null = 'Lab Ally',
  ) {
    kill(ctx, perm);
    // A free instant in hand makes priority a real choice (not a forced pass) with the trigger up.
    conjure(ctx, 'P1', RESPONSE, 'hand');
    let responded = false;
    pump(runPrioritySequence(ctx), (decision, count) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) {
        if (!responded && ctx.state.stack.length > 0) {
          responded = true;
          meanwhile();
        }
        return { index: pass, targets: new Map() };
      }
      return chooseHost(name)(decision, count);
    });
    expect(responded, 'a player held priority with the trigger on the stack').toBe(true);
  }

  /** Kill `perm` and let the trigger go on the stack and resolve, choosing the host by `name`. */
  function dieAndSettle(
    ctx: GameContext,
    perm: EnginePermanent,
    name: string | null = null,
    offered: string[][] = [],
  ) {
    kill(ctx, perm);
    return settle(ctx, chooseHost(name, offered));
  }

  it('screams-from-within-pinned-oracle-supported — the interpreter alone models the -1/-1 and the untargeted return from your graveyard', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    // Enchanted creature gets -1/-1: a layer 7d modification of the attached creature only.
    expect(def.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 7, sublayer: 'd', power: -1, toughness: -1 },
      },
    ]);
    // When enchanted creature dies, return this card from your graveyard: no target (CR 303.4f).
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'dies',
      subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([
      { op: 'returnDepartedSourceToBattlefield', fromYourGraveyard: true },
    ]);
  });

  it('screams-from-within-enchant-creature — it is cast targeting a creature, never a player or a noncreature permanent, and attaches on resolution', () => {
    const ctx = pod('screams-cast');
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    const relic = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Relic',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
    );
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), SCREAMS_MANA);
    const option = optionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    const legal = option!.targets!.flatMap((slot) => slot.options).sort();
    expect(legal).toEqual([bear.id, enemy.id].sort());
    expect(legal).not.toContain(relic.id);
    expect(legal).not.toContain('P2');
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, enemy.id]]),
    );
    resolveTop(ctx);
    const [aura] = named(ctx, 'Screams from Within');
    expect(aura?.attachedTo).toBe(enemy.id);
    expect(aura?.controllerId).toBe('P1');
    expect(effectivePT(ctx, enemy)).toEqual({ power: 1, toughness: 1 });
    expect(effectivePT(ctx, bear)).toEqual({ power: 2, toughness: 2 });
  });

  it('screams-from-within-minus-one-enchanted-only — the enchanted creature gets -1/-1 and nothing else does', () => {
    const { ctx, screams, bear, ally, enemy } = board('screams-pt');
    expect(effectivePT(ctx, bear)).toEqual({ power: 1, toughness: 1 });
    expect(effectivePT(ctx, ally)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    // Moved onto another creature, the -1/-1 moves with it.
    screams.attachedTo = enemy.id;
    expect(effectivePT(ctx, enemy)).toEqual({ power: 1, toughness: 1 });
    expect(effectivePT(ctx, bear)).toEqual({ power: 2, toughness: 2 });
    // Unattached it shrinks nobody.
    screams.attachedTo = null;
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, ally)).toEqual({ power: 2, toughness: 2 });

    // A 1/1 it enchants is 0/0 and dies on its own; the trigger then returns the Aura.
    const small = pod('screams-pt-lethal');
    const aura = spawn(small, 'P1', card);
    const mite = spawn(small, 'P1', CREATURE('Lab Mite', '1', '1'));
    const other = spawn(small, 'P1', CREATURE('Lab Other'));
    aura.attachedTo = mite.id;
    expect(effectivePT(small, mite)).toEqual({ power: 0, toughness: 0 });
    settle(small, chooseHost('Lab Other'));
    expect(named(small, 'Lab Mite')).toEqual([]);
    expect(graveyardOf(small, 'P1')).toEqual(['Lab Mite']);
    const [back] = named(small, 'Screams from Within');
    expect(back?.attachedTo).toBe(other.id);
    expect(effectivePT(small, other)).toEqual({ power: 1, toughness: 1 });
  });

  it('screams-from-within-returns-from-graveyard — when the enchanted creature dies the Aura card returns to the battlefield and its controller chooses a creature to enchant', () => {
    const { ctx, screams, bear, ally, enemy, hexproof } = board('screams-return');
    const offered: string[][] = [];
    dieAndSettle(ctx, bear, 'Lab Ally', offered);
    // The Aura went to the graveyard with the creature (CR 704.5m) and came back off its trigger.
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab Bear']);
    const [back] = named(ctx, 'Screams from Within');
    expect(back).toBeDefined();
    expect(back?.id).not.toBe(screams.id);
    expect(back?.controllerId).toBe('P1');
    expect(back?.attachedTo).toBe(ally.id);
    expect(effectivePT(ctx, ally)).toEqual({ power: 1, toughness: 1 });
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    // The choice was made as it entered, not by targeting, among every creature on the battlefield
    // - including the opponent's hexproof one (CR 303.4f) - but not the creature that just died.
    expect(offered).toHaveLength(1);
    expect([...offered[0]!].sort()).toEqual(['Lab Ally', 'Lab Enemy', hexproof.name].sort());
    expect(ctx.state.stack).toEqual([]);

    // The returned Aura is a new object that triggers again: it can chain.
    dieAndSettle(ctx, ally, 'Lab Enemy');
    expect(graveyardOf(ctx, 'P1')).toEqual(['Lab Bear', 'Lab Ally']);
    const [again] = named(ctx, 'Screams from Within');
    expect(again?.attachedTo).toBe(enemy.id);
    expect(graveyardOf(ctx, 'P1')).not.toContain('Screams from Within');
  });

  it('screams-from-within-hexproof-host — the host is chosen on entering, not targeted, so a hexproof opponent creature is a legal choice and gets -1/-1', () => {
    const { ctx, bear, hexproof } = board('screams-hexproof');
    // A hexproof creature cannot be targeted by the Aura spell cast ...
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), SCREAMS_MANA);
    const cast = optionFor(ctx, 'P1', inHand.id);
    expect(cast!.targets!.flatMap((slot) => slot.options)).not.toContain(hexproof.id);
    // ... but the return can enchant it.
    dieAndSettle(ctx, bear, hexproof.name);
    const [back] = ctx.state.battlefield.filter(
      (perm) => perm.name === 'Screams from Within' && perm.id !== inHand.id,
    );
    expect(back?.attachedTo).toBe(hexproof.id);
    expect(back?.controllerId).toBe('P1');
    expect(effectivePT(ctx, hexproof)).toEqual({ power: 1, toughness: 1 });
  });

  it('screams-from-within-no-creature-stays — with no creature to enchant it stays in the graveyard (CR 303.4i)', () => {
    const ctx = pod('screams-lonely');
    const screams = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', CREATURE('Lab Bear'));
    screams.attachedTo = bear.id;
    const offered: string[][] = [];
    dieAndSettle(ctx, bear, null, offered);
    // No creature remains, so no host was offered and the card is still in the graveyard.
    expect(offered).toEqual([]);
    expect(named(ctx, 'Screams from Within')).toEqual([]);
    expect(graveyardOf(ctx, 'P1').sort()).toEqual(['Lab Bear', 'Screams from Within']);
    expect(ctx.state.stack).toEqual([]);
    // A planeswalker or artifact is no host: still nothing to enchant.
    const walker = pod('screams-lonely-artifact');
    const aura = spawn(walker, 'P1', card);
    const dying = spawn(walker, 'P1', CREATURE('Lab Bear'));
    spawn(
      walker,
      'P2',
      oracle({
        name: 'Lab Relic',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
    );
    aura.attachedTo = dying.id;
    dieAndSettle(walker, dying);
    expect(named(walker, 'Screams from Within')).toEqual([]);
    expect(graveyardOf(walker, 'P1')).toContain('Screams from Within');
  });

  it('screams-from-within-your-graveyard — it returns only if it is in your graveyard: not exiled first, not a card an opponent owns', () => {
    // Exiled from the graveyard before the trigger resolves: it stays in exile.
    const exiled = board('screams-exiled');
    dieThenRespond(exiled.ctx, exiled.bear, () => {
      const inYard = playerById(exiled.ctx, 'P1').graveyard.find(
        (c) => c.name === 'Screams from Within',
      );
      expect(inYard).toBeDefined();
      pump(moveObject(exiled.ctx, inYard!, { zone: 'exile' }));
    });
    expect(named(exiled.ctx, 'Screams from Within')).toEqual([]);
    expect(exiled.ctx.state.exile.map((c) => c.name)).toEqual(['Screams from Within']);

    // Left and came back as a new object: that is not the card the trigger remembers.
    const hand = board('screams-bounced');
    dieThenRespond(hand.ctx, hand.bear, () => {
      const inYard = playerById(hand.ctx, 'P1').graveyard.find(
        (c) => c.name === 'Screams from Within',
      )!;
      pump(moveObject(hand.ctx, inYard, { zone: 'hand' }));
      const inHand = playerById(hand.ctx, 'P1').hand.find((c) => c.name === 'Screams from Within');
      pump(moveObject(hand.ctx, inHand!, { zone: 'graveyard' }));
    });
    expect(named(hand.ctx, 'Screams from Within')).toEqual([]);
    expect(graveyardOf(hand.ctx, 'P1')).toContain('Screams from Within');

    // Control: untouched in your graveyard, it returns.
    const control = board('screams-control');
    dieAndSettle(control.ctx, control.bear, 'Lab Ally');
    expect(named(control.ctx, 'Screams from Within')).toHaveLength(1);

    // P1 controls an Aura that P2 owns: it dies into P2's graveyard, which is not "your
    // graveyard" for P1's trigger, so it stays there.
    const stolen = board('screams-stolen');
    stolen.screams.ownerId = 'P2';
    dieAndSettle(stolen.ctx, stolen.bear, 'Lab Ally');
    expect(graveyardOf(stolen.ctx, 'P2')).toEqual(['Screams from Within']);
    expect(graveyardOf(stolen.ctx, 'P1')).toEqual(['Lab Bear']);
    expect(named(stolen.ctx, 'Screams from Within')).toEqual([]);

    // The reverse: P2 controls an Aura P1 owns. It goes to P1's graveyard, not the controller's.
    const lent = board('screams-lent');
    lent.screams.controllerId = 'P2';
    dieAndSettle(lent.ctx, lent.bear, 'Lab Enemy');
    expect(graveyardOf(lent.ctx, 'P1')).toEqual(['Lab Bear', 'Screams from Within']);
    expect(named(lent.ctx, 'Screams from Within')).toEqual([]);
  });

  it('screams-from-within-enchanted-dies-only — another creature dying, or the Aura leaving alone, returns nothing', () => {
    // Another creature of yours dying does not trigger it: the Aura stays on its creature.
    const beside = board('screams-beside');
    dieAndSettle(beside.ctx, beside.ally);
    expect(beside.screams.attachedTo).toBe(beside.bear.id);
    expect(named(beside.ctx, 'Screams from Within')).toEqual([beside.screams]);
    expect(graveyardOf(beside.ctx, 'P1')).toEqual(['Lab Ally']);

    // An opponent's creature dying does not either.
    dieAndSettle(beside.ctx, beside.enemy);
    expect(named(beside.ctx, 'Screams from Within')).toEqual([beside.screams]);

    // The Aura itself leaving (destroyed, exiled or bounced) while the creature lives is not the
    // creature dying: it stays where it went.
    const destroyed = board('screams-aura-dies');
    kill(destroyed.ctx, destroyed.screams);
    settle(destroyed.ctx, chooseHost('Lab Ally'));
    expect(graveyardOf(destroyed.ctx, 'P1')).toEqual(['Screams from Within']);
    expect(named(destroyed.ctx, 'Screams from Within')).toEqual([]);
    expect(destroyed.ctx.state.stack).toEqual([]);

    // The enchanted creature leaving without dying (exile, bounce) does not trigger it; the Aura
    // falls off into the graveyard and stays there.
    const exiled = board('screams-creature-exiled');
    pump(moveObject(exiled.ctx, exiled.bear, { zone: 'exile' }));
    settle(exiled.ctx, chooseHost('Lab Ally'));
    expect(named(exiled.ctx, 'Screams from Within')).toEqual([]);
    expect(graveyardOf(exiled.ctx, 'P1')).toEqual(['Screams from Within']);
    const bounced = board('screams-creature-bounced');
    pump(moveObject(bounced.ctx, bounced.bear, { zone: 'hand' }));
    settle(bounced.ctx, chooseHost('Lab Ally'));
    expect(named(bounced.ctx, 'Screams from Within')).toEqual([]);
    expect(graveyardOf(bounced.ctx, 'P1')).toEqual(['Screams from Within']);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.13 Shielded by Faith
// ---------------------------------------------------------------------------------------------

describe('Shielded by Faith', () => {
  const { card } = pinned('Shielded by Faith');
  const CREATURE = (name: string, manaCost = '{0}') =>
    oracle({ name, typeLine: 'Creature — Secret', manaCost });
  const SMITE = oracle({
    name: 'Lab Smite',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'Destroy target creature.',
  });
  const BLAST = oracle({
    name: 'Lab Blast',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'Lab Blast deals 5 damage to target creature.',
  });
  const RESPONSE = oracle({
    name: 'Lab Response',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });

  /** P1 controls Shielded by Faith enchanting Lab Host, plus Lab Other; P2 controls Lab Enemy. */
  function board(seed: string) {
    const ctx = pod(seed);
    const aura = spawn(ctx, 'P1', card);
    const host = spawn(ctx, 'P1', CREATURE('Lab Host'));
    const other = spawn(ctx, 'P1', CREATURE('Lab Other'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    aura.attachedTo = host.id;
    return { ctx, aura, host, other, enemy };
  }

  const named = (ctx: GameContext, name: string) =>
    ctx.state.battlefield.filter((perm) => perm.name === name);
  const alive = (ctx: GameContext, perm: EnginePermanent) => ctx.state.battlefield.includes(perm);

  /** P1 casts an instant at `targetId` through the normal path and lets it resolve. */
  function castAt(ctx: GameContext, spell: OracleCard, targetId: string) {
    const object = conjure(ctx, 'P1', spell, 'hand');
    const option = optionFor(ctx, 'P1', object.id);
    expect(option, `P1 casts ${spell.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, targetId]]),
    );
    resolveTop(ctx);
    return settle(ctx);
  }

  /** The "you may attach" prompts put to anyone, answered yes or no. */
  function asking(choice: 'yes' | 'no') {
    const asked: { player: string; prompt: string }[] = [];
    const answer: Answer = (decision) => {
      if (/use this ability/.test(decision.prompt)) {
        asked.push({ player: decision.player, prompt: decision.prompt });
        const wanted = choice === 'yes' ? 'acceptTrigger' : 'declineTrigger';
        return {
          index: decision.options.findIndex((option) => option.type === wanted),
          targets: new Map(),
        };
      }
      return { index: 0, targets: new Map() };
    };
    return { asked, answer };
  }

  /** P1 casts a free creature; its enters trigger resolves with `choice`. */
  function creatureEnters(ctx: GameContext, name: string, choice: 'yes' | 'no') {
    const run = asking(choice);
    castFromHand(ctx, 'P1', CREATURE(name), []);
    resolveTop(ctx);
    settle(ctx, run.answer);
    return run.asked;
  }

  it('shielded-by-faith-pinned-oracle-supported — the interpreter alone models the indestructible grant and the optional attach to any entering creature', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.spellAbility?.effects).toEqual([]);
    // Enchanted creature has indestructible: a layer 6 keyword on the creature it is attached to.
    expect(def.staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'indestructible' } },
    ]);
    // Any creature entering, yours or not, with a "you may": one optional, untargeted trigger.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'enters',
      subject: { kind: 'permanent', selector: { kind: 'type', value: 'Creature' } },
    });
    expect(trigger!.optional).toBe(true);
    expect(trigger!.targets).toEqual([]);
    expect(trigger!.effects).toEqual([{ op: 'attach', what: 'source', to: 'triggerObject' }]);
  });

  it('shielded-by-faith-indestructible-enchanted-only — only the enchanted creature is indestructible: it survives destroy and lethal damage, nothing else does', () => {
    const { ctx, aura, host, other, enemy } = board('shielded-indestructible');
    expect(hasKeyword(ctx, host, 'indestructible')).toBe(true);
    expect(hasKeyword(ctx, other, 'indestructible')).toBe(false);
    expect(hasKeyword(ctx, enemy, 'indestructible')).toBe(false);
    // The Aura grants it; the Aura itself is not indestructible.
    expect(hasKeyword(ctx, aura, 'indestructible')).toBe(false);

    // Destroy and five damage each leave the enchanted 2/2 on the battlefield, undamaged by death.
    castAt(ctx, SMITE, host.id);
    expect(alive(ctx, host)).toBe(true);
    castAt(ctx, BLAST, host.id);
    expect(alive(ctx, host)).toBe(true);
    expect(playerById(ctx, 'P1').graveyard.map((c) => c.name)).toEqual(['Lab Smite', 'Lab Blast']);

    // The same spells kill creatures it is not on.
    castAt(ctx, SMITE, other.id);
    expect(alive(ctx, other)).toBe(false);
    castAt(ctx, BLAST, enemy.id);
    expect(alive(ctx, enemy)).toBe(false);

    // Unattached, it grants nothing: the former host dies to the same destroy effect.
    aura.attachedTo = null;
    expect(hasKeyword(ctx, host, 'indestructible')).toBe(false);
    castAt(ctx, SMITE, host.id);
    expect(alive(ctx, host)).toBe(false);
  });

  it("shielded-by-faith-attach-any-creature — any creature entering, yours or an opponent's, offers the optional attach; yes moves it with a new timestamp and the indestructible with it, no leaves it", () => {
    // Yes, for your own creature: the Aura leaves Lab Host and indestructible follows.
    const mine = board('shielded-yes');
    const stamp = mine.aura.timestamp;
    const yes = creatureEnters(mine.ctx, 'Lab Newcomer', 'yes');
    const [newcomer] = named(mine.ctx, 'Lab Newcomer');
    expect(yes).toHaveLength(1);
    expect(yes[0]!.player).toBe('P1');
    expect(mine.aura.attachedTo).toBe(newcomer?.id);
    expect(mine.aura.timestamp).toBeGreaterThan(stamp);
    expect(hasKeyword(mine.ctx, newcomer!, 'indestructible')).toBe(true);
    expect(hasKeyword(mine.ctx, mine.host, 'indestructible')).toBe(false);
    expect(mine.ctx.state.stack).toEqual([]);
    // It really protects the new host: a destroy spell cannot kill it.
    castAt(mine.ctx, SMITE, newcomer!.id);
    expect(alive(mine.ctx, newcomer!)).toBe(true);

    // No: nothing moves, and the timestamp is unchanged.
    const declined = board('shielded-no');
    const keptStamp = declined.aura.timestamp;
    const no = creatureEnters(declined.ctx, 'Lab Newcomer', 'no');
    expect(no).toHaveLength(1);
    expect(declined.aura.attachedTo).toBe(declined.host.id);
    expect(declined.aura.timestamp).toBe(keptStamp);
    expect(hasKeyword(declined.ctx, declined.host, 'indestructible')).toBe(true);
    expect(
      hasKeyword(declined.ctx, named(declined.ctx, 'Lab Newcomer')[0]!, 'indestructible'),
    ).toBe(false);

    // An opponent's creature entering asks the Aura's controller P1, and may move it onto that
    // creature (it enchants any creature, not only yours).
    const theirs = board('shielded-opponent');
    const run = asking('yes');
    const entering = conjure(theirs.ctx, 'P2', CREATURE('Lab Intruder'), 'hand');
    pump(moveObject(theirs.ctx, entering, { zone: 'battlefield' }));
    settle(theirs.ctx, run.answer);
    const [intruder] = named(theirs.ctx, 'Lab Intruder');
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0]!.player).toBe('P1');
    expect(intruder?.controllerId).toBe('P2');
    expect(theirs.aura.attachedTo).toBe(intruder?.id);
    expect(theirs.aura.controllerId).toBe('P1');
    expect(hasKeyword(theirs.ctx, intruder!, 'indestructible')).toBe(true);

    // Negative: a noncreature permanent entering asks nothing and moves nothing.
    const plain = board('shielded-noncreature');
    const quiet = asking('yes');
    castFromHand(plain.ctx, 'P1', LAB_ARTIFACT('Lab Trinket'), generic(1));
    resolveTop(plain.ctx);
    settle(plain.ctx, quiet.answer);
    expect(named(plain.ctx, 'Lab Trinket')).toHaveLength(1);
    expect(quiet.asked).toEqual([]);
    expect(plain.aura.attachedTo).toBe(plain.host.id);
  });

  it("shielded-by-faith-cant-attach-or-gone — it doesn't move to a creature that left before the trigger resolved, and an Aura that left asks nothing (CR 701.3b)", () => {
    // The entering creature dies in response to the trigger: the Aura stays on Lab Host.
    const gone = board('shielded-gone');
    const newcomer = castFromHand(gone.ctx, 'P1', CREATURE('Lab Newcomer'), []);
    resolveTop(gone.ctx);
    const [entered] = named(gone.ctx, 'Lab Newcomer');
    expect(entered, newcomer.name).toBeDefined();
    conjure(gone.ctx, 'P1', RESPONSE, 'hand');
    let responded = false;
    const run = asking('yes');
    pump(runPrioritySequence(gone.ctx), (decision, count) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0 && !responded && gone.ctx.state.stack.length > 0) {
        responded = true;
        kill(gone.ctx, entered!);
        return { index: pass, targets: new Map() };
      }
      if (pass >= 0) return { index: pass, targets: new Map() };
      return run.answer(decision, count);
    });
    expect(responded, 'a player held priority with the trigger on the stack').toBe(true);
    expect(named(gone.ctx, 'Lab Newcomer')).toEqual([]);
    expect(gone.aura.attachedTo).toBe(gone.host.id);
    expect(hasKeyword(gone.ctx, gone.host, 'indestructible')).toBe(true);

    // The Aura itself is not on the battlefield (it died earlier): a creature entering asks nothing.
    const bare = board('shielded-aura-gone');
    kill(bare.ctx, bare.aura);
    const quiet = asking('yes');
    castFromHand(bare.ctx, 'P1', CREATURE('Lab Newcomer'), []);
    resolveTop(bare.ctx);
    settle(bare.ctx, quiet.answer);
    expect(quiet.asked).toEqual([]);
    expect(playerById(bare.ctx, 'P1').graveyard.map((c) => c.name)).toEqual(['Shielded by Faith']);
    expect(named(bare.ctx, 'Lab Newcomer')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.15 Sunforger
// ---------------------------------------------------------------------------------------------

describe('Sunforger', () => {
  const { card } = pinned('Sunforger');
  const EQUIP = /: Equip \{3\}$/;
  const SEARCH = /Unattach this Equipment/;
  const R = { symbol: 'R' as const };
  const W = { symbol: 'W' as const };
  const CREATURE = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });
  const SWORD = oracle({
    name: 'Lab Sword',
    typeLine: 'Artifact — Equipment',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Equipped creature gets +1/+1.\nEquip {1}',
  });
  const QUICK = oracle({
    name: 'Lab Quick',
    typeLine: 'Instant',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText: 'You gain 1 life.',
  });
  /** An observer: every spell you cast gains you 1 life, so a cast (not a move) is visible. */
  const WATCHER = oracle({
    name: 'Lab Watcher',
    typeLine: 'Enchantment',
    manaCost: '{1}',
    power: null,
    toughness: null,
    oracleText: 'Whenever you cast a spell, you gain 1 life.',
  });
  /** A library spell that gains `life` life, so which one resolved is visible. */
  const SPELL = (
    name: string,
    typeLine: 'Instant' | 'Sorcery',
    colors: ('W' | 'U' | 'B' | 'R' | 'G')[],
    cmc: number,
    life: number,
  ) =>
    oracle({
      name,
      typeLine,
      colors,
      cmc,
      manaCost: `{${cmc}}`,
      power: null,
      toughness: null,
      oracleText: `You gain ${life} life.`,
    });
  // Offered: red, white, red-and-blue, and the mana value 4 boundary. Not offered: blue, a red
  // sorcery, a red instant with mana value 5, and a colorless instant.
  const BOLT = SPELL('Lab Red Instant', 'Instant', ['R'], 2, 3);
  const WARD = SPELL('Lab White Instant Four', 'Instant', ['W'], 4, 5);
  const PRISM = SPELL('Lab Red Blue Instant', 'Instant', ['U', 'R'], 3, 7);
  const BLUE = SPELL('Lab Blue Instant', 'Instant', ['U'], 2, 11);
  const BURN = SPELL('Lab Red Sorcery', 'Sorcery', ['R'], 2, 13);
  const BIG = SPELL('Lab Red Instant Five', 'Instant', ['R'], 5, 17);
  const CLEAR = SPELL('Lab Colorless Instant', 'Instant', [], 1, 19);
  const MATCHING = [BOLT, WARD, PRISM];
  const NON_MATCHING = [BLUE, BURN, BIG, CLEAR];

  /** P1 controls Sunforger (unattached) and two 2/2 creatures; an opponent controls a third. */
  function board(seed: string, library: OracleCard[] = [...MATCHING, ...NON_MATCHING]) {
    const ctx = pod(seed);
    const sunforger = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', CREATURE('Lab First'));
    const second = spawn(ctx, 'P1', CREATURE('Lab Second'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    for (const entry of library) conjure(ctx, 'P1', entry, 'library');
    return { ctx, sunforger, first, second, enemy };
  }

  const life = (ctx: GameContext, playerId: string) => playerById(ctx, playerId).life;
  const libraryNames = (ctx: GameContext) => playerById(ctx, 'P1').library.map((c) => c.name);
  const shuffles = (ctx: GameContext) =>
    ctx.state.eventLog.filter((event) => event.type === 'shuffle').length;
  const stackNames = (ctx: GameContext) => ctx.state.stack.map((entry) => entry.description);

  /** Pay {R}{W} and activate the search ability on the real priority path; it stays on the stack. */
  function activate(ctx: GameContext, sunforger: EnginePermanent, extra = 0) {
    addMana(playerById(ctx, 'P1'), [R, W, ...generic(extra)]);
    const option = optionFor(ctx, 'P1', sunforger.id, SEARCH);
    expect(option, 'Sunforger search activation').toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
  }

  /**
   * Resolve the top of the stack, answering the search with the card named `pick` (or "find
   * nothing" for `null`); returns the options the search offered, if it asked at all.
   */
  function resolveSearch(ctx: GameContext, pick: string | null) {
    let offered: string[] | null = null;
    resolveTop(ctx, (decision) => {
      offered = decision.options.map((option) => option.description);
      const index =
        pick === null
          ? decision.options.findIndex((option) => option.type === 'findNothing')
          : decision.options.findIndex((option) => option.description.includes(pick));
      expect(index, `search option for ${pick}`).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    });
    return offered as string[] | null;
  }

  /** Put Sunforger on `target` through Equip {3} on the real priority path. */
  function equip(ctx: GameContext, sunforger: EnginePermanent, target: EnginePermanent) {
    addMana(playerById(ctx, 'P1'), generic(3));
    const option = optionFor(ctx, 'P1', sunforger.id, EQUIP);
    expect(option, `Equip {3} onto ${target.name}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[option!.targets![0]!.slot, target.id]]),
    );
    resolveTop(ctx);
  }

  it('sunforger-pinned-oracle-supported — the interpreter alone models the +4/+0 static, the unattach search activation and Equip {3}', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Equipped creature gets +4/+0: a layer 7d power modification of the attached creature only.
    expect(def.staticEffects).toEqual([
      {
        affects: { kind: 'attachedToSource' },
        op: { layer: 7, sublayer: 'd', power: 4, toughness: 0 },
      },
    ]);
    expect(def.triggers).toEqual([]);
    expect(def.activatedAbilities).toHaveLength(2);
    const [search, equipAbility] = def.activatedAbilities;
    // {R}{W}, Unattach this Equipment: instant speed, two costs, no targets.
    expect(search!.timing).toBe('any');
    expect(search!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 0, colored: { W: 1, U: 0, B: 0, R: 1, G: 0 }, colorless: 0 },
      },
      { kind: 'unattachSelf' },
    ]);
    expect(search!.ability.targets).toEqual([]);
    // Search for a red or white instant with mana value 4 or less and cast it free, then shuffle.
    expect(search!.ability.effects).toEqual([
      {
        op: 'searchLibraryCastFree',
        filter: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Instant' },
            {
              kind: 'anyOf',
              of: [
                { kind: 'color', value: 'R' },
                { kind: 'color', value: 'W' },
              ],
            },
            { kind: 'manaValueAtMost', n: 4 },
          ],
        },
      },
      { op: 'shuffle' },
    ]);
    // Equip {3}: sorcery speed (CR 702.6a), a creature you control.
    expect(equipAbility!.timing).toBe('sorcery');
    expect(equipAbility!.costs).toEqual([
      {
        kind: 'mana',
        cost: { generic: 3, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(equipAbility!.ability.targets).toEqual([{ kind: 'creature', controller: 'you' }]);
    expect(equipAbility!.ability.effects).toEqual([{ op: 'attachSelfTo', target: 0 }]);
  });

  it('sunforger-pump-equipped-only — the equipped creature gets +4/+0, no other creature does, and toughness is untouched', () => {
    const { ctx, sunforger, first, second, enemy } = board('sunforger-pump');
    // Unattached, Sunforger pumps nothing.
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });

    sunforger.attachedTo = first.id;
    expect(effectivePT(ctx, first)).toEqual({ power: 6, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });

    // It stacks with another Equipment on the same creature, and a different Equipment on the
    // other creature does not move Sunforger's bonus.
    const sword = spawn(ctx, 'P1', SWORD);
    sword.attachedTo = first.id;
    expect(effectivePT(ctx, first)).toEqual({ power: 7, toughness: 3 });
    sword.attachedTo = second.id;
    expect(effectivePT(ctx, first)).toEqual({ power: 6, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 3, toughness: 3 });

    // Moving it (Equip {3}) moves the bonus: Second gains it and First loses it.
    equip(ctx, sunforger, second);
    expect(sunforger.attachedTo).toBe(second.id);
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 7, toughness: 3 });
  });

  it('sunforger-activation-requires-attached — the {R}{W} ability is offered only while attached, and only with both colors', () => {
    const { ctx, sunforger, first } = board('sunforger-attached');
    // Unattached with {R}{W} ready: not offered (it cannot unattach), though Equip {3} is not
    // affordable either.
    addMana(playerById(ctx, 'P1'), [R, W, ...generic(3)]);
    expect(optionFor(ctx, 'P1', sunforger.id, SEARCH)).toBeUndefined();
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeDefined();

    // Attached with {R}{W}: offered.
    sunforger.attachedTo = first.id;
    const offered = optionFor(ctx, 'P1', sunforger.id, SEARCH);
    expect(offered).toBeDefined();
    expect(offered!.targets ?? []).toEqual([]);

    // Missing either color: not offered, and nothing is paid or unattached.
    for (const [label, mana] of [
      ['only R', [R, ...generic(4)]],
      ['only W', [W, ...generic(4)]],
      ['only generic', generic(5)],
    ] as const) {
      const lacking = board(`sunforger-lacking-${label}`);
      lacking.sunforger.attachedTo = lacking.first.id;
      addMana(playerById(lacking.ctx, 'P1'), [...mana]);
      expect(optionFor(lacking.ctx, 'P1', lacking.sunforger.id, SEARCH), label).toBeUndefined();
      expect(lacking.sunforger.attachedTo, label).toBe(lacking.first.id);
    }

    // Instant speed: still offered on an opponent's turn and with a spell on the stack.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(optionFor(ctx, 'P1', sunforger.id, SEARCH)).toBeDefined();
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    castFromHand(ctx, 'P1', QUICK, []);
    expect(ctx.state.stack).toHaveLength(1);
    expect(optionFor(ctx, 'P1', sunforger.id, SEARCH)).toBeDefined();
  });

  it('sunforger-unattach-is-a-cost — paying {R}{W} unattaches it up front; Sunforger stays on the battlefield and the creature loses +4/+0', () => {
    const { ctx, sunforger, first, second } = board('sunforger-unattach');
    sunforger.attachedTo = first.id;
    expect(effectivePT(ctx, first)).toEqual({ power: 6, toughness: 2 });

    activate(ctx, sunforger, 1);
    // The cost is paid on activation, before the ability resolves: exactly {R}{W} left the pool
    // (the spare generic mana is still there), Sunforger is unattached but on the battlefield,
    // and the ability waits on the stack.
    expect(playerById(ctx, 'P1').manaEntries.map((mana) => mana.symbol)).toEqual(['C']);
    expect(ctx.state.stack).toHaveLength(1);
    expect(sunforger.attachedTo ?? null).toBeNull();
    expect(ctx.state.battlefield.map((perm) => perm.id)).toContain(sunforger.id);
    expect(playerById(ctx, 'P1').graveyard.map((c) => c.name)).toEqual([]);
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(effectivePT(ctx, second)).toEqual({ power: 2, toughness: 2 });

    // Unattached it cannot be activated again, even with more mana, and it stays unattached after
    // the ability resolves.
    addMana(playerById(ctx, 'P1'), [R, W]);
    expect(optionFor(ctx, 'P1', sunforger.id, SEARCH)).toBeUndefined();
    resolveSearch(ctx, null);
    expect(sunforger.attachedTo ?? null).toBeNull();
    expect(ctx.state.battlefield.map((perm) => perm.id)).toContain(sunforger.id);
    expect(effectivePT(ctx, first)).toEqual({ power: 2, toughness: 2 });
    expect(optionFor(ctx, 'P1', sunforger.id, SEARCH)).toBeUndefined();

    // It can be equipped again afterwards and the bonus comes back.
    equip(ctx, sunforger, second);
    expect(effectivePT(ctx, second)).toEqual({ power: 6, toughness: 2 });
  });

  it('sunforger-search-filter — only red or white instants with mana value 4 or less are offered', () => {
    const { ctx, sunforger, first } = board('sunforger-filter');
    sunforger.attachedTo = first.id;
    activate(ctx, sunforger);
    const offered = resolveSearch(ctx, null);
    expect(offered).not.toBeNull();
    const found = offered!.filter((description) => /^Cast /.test(description));
    // Offered: a red instant, a white instant at mana value 4, and a red-and-blue instant.
    expect(found).toHaveLength(MATCHING.length);
    for (const spell of MATCHING)
      expect(
        found.some((description) => description.includes(spell.name)),
        spell.name,
      ).toBe(true);
    // Not offered: a blue instant, a red sorcery, a red instant at mana value 5, a colorless instant.
    for (const spell of NON_MATCHING)
      expect(
        offered!.some((description) => description.includes(spell.name)),
        spell.name,
      ).toBe(false);
    // The search may always find nothing.
    expect(offered).toContain('Find nothing');
    // Finding nothing leaves every card in the library: nothing was cast or moved.
    expect(ctx.state.stack).toEqual([]);
    expect([...libraryNames(ctx)].sort()).toEqual(
      [...MATCHING, ...NON_MATCHING, ...Array.from({ length: 8 }, () => ({ name: 'Forest' }))]
        .map((entry) => entry.name)
        .sort(),
    );
  });

  it('sunforger-free-cast — the found card is cast without paying its mana cost, so cast triggers fire; finding nothing casts nothing', () => {
    // Positive: the mana value 4 white instant is cast with nothing in the mana pool.
    const cast = board('sunforger-cast');
    spawn(cast.ctx, 'P1', WATCHER);
    cast.sunforger.attachedTo = cast.first.id;
    activate(cast.ctx, cast.sunforger);
    expect(life(cast.ctx, 'P1')).toBe(40);
    resolveSearch(cast.ctx, WARD.name);
    // It is on the stack as a spell (a cast, not a move or a resolution), paid for with nothing.
    expect(stackNames(cast.ctx)).toEqual([WARD.name]);
    expect(cast.ctx.state.stack[0]!.kind).toBe('spell');
    expect(playerById(cast.ctx, 'P1').manaEntries).toEqual([]);
    expect(libraryNames(cast.ctx)).not.toContain(WARD.name);
    // Not resolved yet: the life gain is only the cast trigger so far, once it resolves.
    expect(life(cast.ctx, 'P1')).toBe(40);
    settle(cast.ctx);
    // The Watcher's cast trigger (+1) and the instant itself (+5) both happened.
    expect(life(cast.ctx, 'P1')).toBe(46);
    expect(cast.ctx.state.stack).toEqual([]);
    expect(playerById(cast.ctx, 'P1').graveyard.map((c) => c.name)).toEqual([WARD.name]);

    // The red-and-blue instant is castable as a red instant, and only the chosen card is cast.
    const prism = board('sunforger-cast-prism');
    prism.sunforger.attachedTo = prism.first.id;
    activate(prism.ctx, prism.sunforger);
    resolveSearch(prism.ctx, PRISM.name);
    expect(stackNames(prism.ctx)).toEqual([PRISM.name]);
    settle(prism.ctx);
    expect(life(prism.ctx, 'P1')).toBe(47);
    expect(libraryNames(prism.ctx)).toContain(BOLT.name);
    expect(libraryNames(prism.ctx)).toContain(WARD.name);

    // Negative: finding nothing casts nothing, so no cast trigger and no life.
    const none = board('sunforger-cast-none');
    spawn(none.ctx, 'P1', WATCHER);
    none.sunforger.attachedTo = none.first.id;
    activate(none.ctx, none.sunforger);
    resolveSearch(none.ctx, null);
    expect(none.ctx.state.stack).toEqual([]);
    settle(none.ctx);
    expect(life(none.ctx, 'P1')).toBe(40);
    expect(playerById(none.ctx, 'P1').graveyard).toEqual([]);
  });

  it('sunforger-then-shuffle — the library is shuffled after the search, whether a card was cast, nothing was found, or nothing matched', () => {
    // A card was cast: one shuffle, after the cast, and the library keeps every other card.
    const cast = board('sunforger-shuffle-cast');
    cast.sunforger.attachedTo = cast.first.id;
    const before = libraryNames(cast.ctx);
    activate(cast.ctx, cast.sunforger);
    expect(shuffles(cast.ctx)).toBe(0);
    resolveSearch(cast.ctx, BOLT.name);
    expect(shuffles(cast.ctx)).toBe(1);
    expect([...libraryNames(cast.ctx)].sort()).toEqual(
      before.filter((name) => name !== BOLT.name).sort(),
    );
    // The seeded shuffle really reorders the remaining cards.
    expect(libraryNames(cast.ctx)).not.toEqual(before.filter((name) => name !== BOLT.name));

    // The player finds nothing although cards matched: still shuffled.
    const declined = board('sunforger-shuffle-declined');
    declined.sunforger.attachedTo = declined.first.id;
    activate(declined.ctx, declined.sunforger);
    resolveSearch(declined.ctx, null);
    expect(shuffles(declined.ctx)).toBe(1);

    // No card matches: no choice is offered, nothing is cast, and the library is still shuffled.
    const empty = board('sunforger-shuffle-nomatch', NON_MATCHING);
    empty.sunforger.attachedTo = empty.first.id;
    const nomatchBefore = libraryNames(empty.ctx);
    activate(empty.ctx, empty.sunforger);
    expect(shuffles(empty.ctx)).toBe(0);
    expect(resolveSearch(empty.ctx, null)).toBeNull();
    expect(empty.ctx.state.stack).toEqual([]);
    expect(shuffles(empty.ctx)).toBe(1);
    expect([...libraryNames(empty.ctx)].sort()).toEqual([...nomatchBefore].sort());
    expect(empty.sunforger.attachedTo ?? null).toBeNull();

    // Negative: before the ability resolves and without activating, no shuffle happens.
    const idle = board('sunforger-shuffle-idle');
    idle.sunforger.attachedTo = idle.first.id;
    settle(idle.ctx);
    expect(shuffles(idle.ctx)).toBe(0);
  });

  it('sunforger-equip-sorcery — Equip {3} is offered only at sorcery speed, only onto a creature you control', () => {
    const { ctx, sunforger, first, second, enemy } = board('sunforger-equip');
    const targetNames = (option: NonNullable<ReturnType<typeof optionFor>>) => {
      const nameOf = (id: string) =>
        ctx.state.battlefield.find((perm) => perm.id === id)?.name ?? id;
      return option.targets!.flatMap((slot) => slot.options.map(nameOf)).sort();
    };

    // Without {3} (two mana) it cannot be activated; {2} was the old, wrong price.
    addMana(playerById(ctx, 'P1'), generic(2));
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();

    // Your main phase, empty stack, {3} available: offered, and only your creatures are legal.
    addMana(playerById(ctx, 'P1'), generic(1));
    const main = optionFor(ctx, 'P1', sunforger.id, EQUIP);
    expect(main).toBeDefined();
    expect(targetNames(main!)).toEqual(['Lab First', 'Lab Second']);
    expect(targetNames(main!)).not.toContain(enemy.name);

    // A spell on the stack: not offered, though the mana is there.
    castFromHand(ctx, 'P1', QUICK, []);
    expect(ctx.state.stack).toHaveLength(1);
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();
    resolveTop(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeDefined();

    // An opponent's turn, and a non-main phase of your own turn: not offered.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();
    ctx.state.phase = 'postcombatMain';
    ctx.state.step = null;
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeDefined();

    // Activating it puts it on the stack; resolving attaches Sunforger to the chosen creature and
    // spends all three mana.
    const option = optionFor(ctx, 'P1', sunforger.id, EQUIP)!;
    takeAction(
      ctx,
      'P1',
      option.payload as PriorityActionPayload,
      undefined,
      new Map([[option.targets![0]!.slot, second.id]]),
    );
    expect(ctx.state.stack).toHaveLength(1);
    expect(sunforger.attachedTo ?? null).toBeNull();
    resolveTop(ctx);
    expect(sunforger.attachedTo).toBe(second.id);
    expect(sunforger.attachedTo).not.toBe(first.id);
    expect(effectivePT(ctx, second)).toEqual({ power: 6, toughness: 2 });
    expect(optionFor(ctx, 'P1', sunforger.id, EQUIP)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// PR05.21 Fallen Ideal
// ---------------------------------------------------------------------------------------------

describe('Fallen Ideal', () => {
  const { card } = pinned('Fallen Ideal');
  const CREATURE = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });
  const SACRIFICE = /sacrifice a creature/;

  /** P1 controls Fallen Ideal on Lab Host plus Lab Fodder and Lab Spare; P2 controls Lab Enemy. */
  function board(seed: string) {
    const ctx = pod(seed);
    const aura = spawn(ctx, 'P1', card);
    const host = spawn(ctx, 'P1', CREATURE('Lab Host'));
    const fodder = spawn(ctx, 'P1', CREATURE('Lab Fodder'));
    const spare = spawn(ctx, 'P1', CREATURE('Lab Spare'));
    const enemy = spawn(ctx, 'P2', CREATURE('Lab Enemy'));
    aura.attachedTo = host.id;
    return { ctx, aura, host, fodder, spare, enemy };
  }

  /** Answer every decision with the option whose description matches `pattern`. */
  const choose =
    (pattern: RegExp): Answer =>
    (decision) => {
      const index = decision.options.findIndex((option) => pattern.test(option.description));
      return { index: Math.max(index, 0), targets: new Map() };
    };

  /** `playerId` activates the granted ability, paying by sacrificing the creature `pattern` names. */
  function sacrifice(
    ctx: GameContext,
    playerId: string,
    source: EnginePermanent,
    pattern: RegExp,
    prompts: string[] = [],
  ) {
    const option = optionFor(ctx, playerId, source.id, SACRIFICE);
    expect(option, `${playerId} activates ${source.name}`).toBeDefined();
    takeAction(ctx, playerId, option!.payload as PriorityActionPayload, (decision) => {
      prompts.push(decision.options.map((candidate) => candidate.description).join(' | '));
      return choose(pattern)(decision, 0);
    });
  }

  const alive = (ctx: GameContext, perm: EnginePermanent) => ctx.state.battlefield.includes(perm);
  const inHand = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).hand.map((c) => c.name);
  const inGraveyard = (ctx: GameContext, playerId: string) =>
    playerById(ctx, playerId).graveyard.map((c) => c.name);

  /** Run the checkpoint so pending triggers are on the stack, without resolving anything. */
  const checkpoint = (ctx: GameContext) => pump(priorityCheckpoint(ctx));

  it('fallen-ideal-pinned-oracle-supported — the interpreter alone models the granted flying and sacrifice ability and the return to hand', () => {
    expectNoRegistration(card);
    expectModeled(card);
    const def = interpretCard(card);
    // Enchant creature: an Aura spell with one creature target and no effect of its own.
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.spellAbility?.effects).toEqual([]);
    // Two layer 6 grants on the creature this Aura is attached to: flying, then the ability.
    expect(def.staticEffects).toHaveLength(2);
    expect(def.staticEffects[0]).toEqual({
      affects: { kind: 'attachedToSource' },
      op: { layer: 6, addKeyword: 'flying' },
    });
    const grant = def.staticEffects[1]!;
    expect(grant.affects).toEqual({ kind: 'attachedToSource' });
    const granted = (grant.op as { addActivatedAbility: { costs: unknown[]; timing: string } })
      .addActivatedAbility;
    // Cost: sacrifice a creature you control, the enchanted creature itself included. No mana.
    expect(granted.timing).toBe('any');
    expect(granted.costs).toEqual([
      {
        kind: 'sacrificeOther',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'type', value: 'Creature' },
          ],
        },
        allowSelf: true,
      },
    ]);
    // Effect: the creature that has the ability (not the Aura) gets +2/+1 until end of turn.
    expect(
      (grant.op as { addActivatedAbility: { ability: { effects: unknown[] } } }).addActivatedAbility
        .ability.effects,
    ).toEqual([{ op: 'pumpEachUntilEot', selector: { kind: 'self' }, power: 2, toughness: 1 }]);
    // The Aura has no activated ability of its own.
    expect(def.activatedAbilities).toEqual([]);
    // When this Aura is put into a graveyard from the battlefield: one mandatory return, which
    // looks only in the graveyard the Aura went to.
    expect(def.triggers).toHaveLength(1);
    const [trigger] = def.triggers;
    expect(trigger!.trigger).toEqual({
      when: 'leavesBattlefield',
      subject: { kind: 'self' },
      leavesTo: ['graveyard'],
    });
    expect(trigger!.optional).toBe(false);
    expect(trigger!.effects).toEqual([{ op: 'returnDepartedSourceToHand', fromGraveyard: true }]);
  });

  it('fallen-ideal-flying-enchanted-only — only the enchanted creature has flying, and it follows the Aura', () => {
    const { ctx, aura, host, fodder, enemy } = board('fallen-flying');
    expect(hasKeyword(ctx, host, 'flying')).toBe(true);
    for (const perm of [fodder, enemy]) expect(hasKeyword(ctx, perm, 'flying')).toBe(false);
    // Moved to another creature, the flying goes with it; unattached, nobody has it.
    aura.attachedTo = enemy.id;
    expect(hasKeyword(ctx, enemy, 'flying')).toBe(true);
    expect(hasKeyword(ctx, host, 'flying')).toBe(false);
    aura.attachedTo = null;
    expect(hasKeyword(ctx, enemy, 'flying')).toBe(false);
    // The ability goes with it too: the unenchanted creatures are offered nothing.
    const bare = board('fallen-flying-bare');
    expect(optionFor(bare.ctx, 'P1', bare.host.id, SACRIFICE)).toBeDefined();
    for (const perm of [bare.fodder, bare.spare, bare.enemy])
      expect(optionFor(bare.ctx, 'P1', perm.id, SACRIFICE)).toBeUndefined();
    bare.aura.attachedTo = null;
    expect(optionFor(bare.ctx, 'P1', bare.host.id, SACRIFICE)).toBeUndefined();
  });

  it('fallen-ideal-sacrifice-pump — sacrificing another creature as the cost gives the enchanted creature +2/+1 until end of turn, once per sacrifice', () => {
    const { ctx, host, fodder, spare, enemy } = board('fallen-pump');
    expect(effectivePT(ctx, host)).toEqual({ power: 2, toughness: 2 });
    const prompts: string[] = [];
    sacrifice(ctx, 'P1', host, /Lab Fodder/, prompts);
    // The cost is paid on activation: the creature is gone while the ability waits on the stack.
    expect(alive(ctx, fodder)).toBe(false);
    expect(inGraveyard(ctx, 'P1')).toContain('Lab Fodder');
    expect(ctx.state.stack).toHaveLength(1);
    expect(effectivePT(ctx, host)).toEqual({ power: 2, toughness: 2 });
    // The choice offered only your own creatures, the enchanted one included.
    expect(prompts.join('\n')).toContain('Lab Host');
    expect(prompts.join('\n')).toContain('Lab Spare');
    expect(prompts.join('\n')).not.toContain('Lab Enemy');
    resolveTop(ctx);
    expect(effectivePT(ctx, host)).toEqual({ power: 4, toughness: 3 });
    // A second sacrifice stacks another +2/+1; nothing else is pumped, and the Aura stays on.
    sacrifice(ctx, 'P1', host, /Lab Spare/);
    resolveTop(ctx);
    expect(alive(ctx, spare)).toBe(false);
    expect(effectivePT(ctx, host)).toEqual({ power: 6, toughness: 4 });
    expect(effectivePT(ctx, enemy)).toEqual({ power: 2, toughness: 2 });
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Fallen Ideal')).toBe(true);
    // Negative: the pump lasts until end of turn only.
    beginEndStep(ctx);
    settle(ctx);
    expect(effectivePT(ctx, host)).toEqual({ power: 6, toughness: 4 });
    ctx.state.currentTurnPlayer = 'P1';
    pump(runTurn(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, () => null);
      if (decision.presentationBlockDeclaration !== undefined)
        return declareBlocks(decision, () => null);
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(effectivePT(ctx, host)).toEqual({ power: 2, toughness: 2 });
  });

  it('fallen-ideal-sacrifice-itself — the enchanted creature may be sacrificed to its own ability, and with no other creature that is the only choice', () => {
    const { ctx, aura, host, fodder, spare } = board('fallen-self');
    for (const perm of [fodder, spare]) pump(moveObject(ctx, perm, { zone: 'graveyard' }));
    const option = optionFor(ctx, 'P1', host.id, SACRIFICE);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    // Lab Host was the only creature to sacrifice, so it paid for its own ability.
    expect(alive(ctx, host)).toBe(false);
    expect(inGraveyard(ctx, 'P1')).toContain('Lab Host');
    // The ability still resolves (there is nothing left to pump) and the Aura was put into the
    // graveyard as a state-based action.
    settle(ctx);
    expect(alive(ctx, aura)).toBe(false);
    expect(ctx.state.stack).toEqual([]);
  });

  it('fallen-ideal-activation-controller — the creature’s controller activates it, whoever controls the Aura', () => {
    const { ctx, aura, enemy } = board('fallen-controller');
    spawn(ctx, 'P2', CREATURE('Lab Enemy Fodder'));
    aura.attachedTo = enemy.id;
    // P1's Aura on P2's creature: P1 is offered nothing; P2 sacrifices P2's creature and pumps it.
    expect(optionFor(ctx, 'P1', enemy.id, SACRIFICE)).toBeUndefined();
    const prompts: string[] = [];
    sacrifice(ctx, 'P2', enemy, /Lab Enemy Fodder/, prompts);
    expect(prompts.join('\n')).not.toContain('Lab Spare');
    resolveTop(ctx);
    expect(effectivePT(ctx, enemy)).toEqual({ power: 4, toughness: 3 });
    expect(inGraveyard(ctx, 'P2')).toEqual(['Lab Enemy Fodder']);
    // None of P1's creatures was touched.
    expect(inGraveyard(ctx, 'P1')).toEqual([]);
  });

  it('fallen-ideal-return-to-owner-hand — when the Aura goes to a graveyard from the battlefield it returns to its owner’s hand, whichever creature it was on', () => {
    // The host dies: the Aura falls off, goes to the graveyard and comes back to P1's hand.
    const { ctx, host } = board('fallen-return-mine');
    kill(ctx, host);
    settle(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Fallen Ideal')).toBe(false);
    expect(inHand(ctx, 'P1')).toContain('Fallen Ideal');
    expect(inGraveyard(ctx, 'P1')).not.toContain('Fallen Ideal');

    // On an opponent's creature it returns to P1's hand, not P2's, when that creature dies.
    const theirs = board('fallen-return-theirs');
    theirs.aura.attachedTo = theirs.enemy.id;
    kill(theirs.ctx, theirs.enemy);
    settle(theirs.ctx);
    expect(inHand(theirs.ctx, 'P1')).toContain('Fallen Ideal');
    expect(inHand(theirs.ctx, 'P2')).not.toContain('Fallen Ideal');
    expect(inGraveyard(theirs.ctx, 'P2')).not.toContain('Fallen Ideal');

    // The Aura itself going to the graveyard (destroyed) returns it as well, with its creature safe.
    const direct = board('fallen-return-destroyed');
    kill(direct.ctx, direct.aura);
    settle(direct.ctx);
    expect(alive(direct.ctx, direct.host)).toBe(true);
    expect(inHand(direct.ctx, 'P1')).toContain('Fallen Ideal');
  });

  it('fallen-ideal-return-only-from-graveyard — exiled from the battlefield it does not return, and a card that left the graveyard before the trigger resolved stays gone', () => {
    // Exiled from the battlefield: not a graveyard move, so nothing triggers.
    const exiled = board('fallen-exiled');
    pump(moveObject(exiled.ctx, exiled.aura, { zone: 'exile' }));
    settle(exiled.ctx);
    expect(inHand(exiled.ctx, 'P1')).not.toContain('Fallen Ideal');
    expect(exiled.ctx.state.exile.map((c) => c.name)).toEqual(['Fallen Ideal']);

    // Put into the graveyard, then exiled from there with the trigger on the stack: no return.
    const gone = board('fallen-graveyard-exiled');
    kill(gone.ctx, gone.host);
    checkpoint(gone.ctx);
    expect(gone.ctx.state.stack).toHaveLength(1);
    const inYard = playerById(gone.ctx, 'P1').graveyard.find((c) => c.name === 'Fallen Ideal')!;
    pump(moveObject(gone.ctx, inYard, { zone: 'exile' }));
    resolveTop(gone.ctx);
    expect(inHand(gone.ctx, 'P1')).not.toContain('Fallen Ideal');
    expect(gone.ctx.state.exile.map((c) => c.name)).toEqual(['Fallen Ideal']);

    // A creature dying with no Aura on it returns nothing.
    const bare = board('fallen-bare');
    kill(bare.ctx, bare.fodder);
    settle(bare.ctx);
    expect(inHand(bare.ctx, 'P1')).toEqual([]);
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
    name: "Ajani's Chosen",
    sha256: 'a9b42ae4f91ea135006bd138f386a48952784159d1076b7493c83a96daef2d48',
    clauseCount: 2,
  },
  {
    name: 'Cranial Plating',
    sha256: '839a622b17160d32a4e55cddfabe41e707f6da95bdc5f96908679d28ae211580',
    clauseCount: 3,
  },
  {
    name: 'Fallen Ideal',
    sha256: '3ba13764d452400831541e37c2b7a16dca91265614e3b979c6d5f27f229e0950',
    clauseCount: 2,
  },
  {
    name: 'Forum Filibuster',
    sha256: '0ba03edb28796d0bf9c9db05a772b35e3a219d24ff8a81648d9a440a2fd35cb2',
    clauseCount: 2,
  },
  {
    name: 'Ghoulish Impetus',
    sha256: 'b0089bf388f7bbd729e9d11a028905de8849348049dff454e450cbd4183d9fdd',
    clauseCount: 3,
  },
  {
    name: 'Gift of Immortality',
    sha256: '668461ed4abe26b27771a49c7c5347b67dc7fddf9aa4e4ff49d3373b1936c781',
    clauseCount: 3,
  },
  {
    name: "Karametra's Favor",
    sha256: 'fe49fa4bdb3ce143c1061103384fabaa3040916d9ca134f94284c26687062683',
    clauseCount: 2,
  },
  {
    name: 'Mask of Memory',
    sha256: 'cb2782319793f55a873e6e3173ae3b04e5bf04806f7b0eb4b96a490a338f0310',
    clauseCount: 2,
  },
  {
    name: 'Redemption Arc',
    sha256: 'c7576127ac9961bc64db1cf2b1cb4072c6d6e9944b6fa4c88f77c01e96d67638',
    clauseCount: 2,
  },
  {
    name: 'Resurrection Orb',
    sha256: 'ef8c39d782702899614fb8e31035302042c3f3f55ddf16c655dce339079c2734',
    clauseCount: 3,
  },
  {
    name: 'Screams from Within',
    sha256: '603a5285b42120672628369f049af0996b854d4928aab8bbaed3f809d63324a3',
    clauseCount: 3,
  },
  {
    name: 'Shielded by Faith',
    sha256: 'd2578f1927629d5684b6da7702f4465f5a18d70f92da7acb414b894f52510fc7',
    clauseCount: 2,
  },
  {
    name: 'Sunforger',
    sha256: '0ae447b31437ff4e3964e1bf8803b551ef7725ee95a31e9d6b168e860bb57b0e',
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

describe('PR05 restoration gate', () => {
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
      (entry) => entry.restoredIn === 'coverage-pr05',
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
