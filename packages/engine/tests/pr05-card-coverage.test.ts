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
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { beginEndStep, runCombatAndExtraCombats, runTurn } from '../src/turn/turn';
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
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
}

const RESTORED: RestoredCard[] = [
  {
    name: 'Cranial Plating',
    sha256: '839a622b17160d32a4e55cddfabe41e707f6da95bdc5f96908679d28ae211580',
    clauseCount: 3,
  },
  {
    name: 'Mask of Memory',
    sha256: 'cb2782319793f55a873e6e3173ae3b04e5bf04806f7b0eb4b96a490a338f0310',
    clauseCount: 2,
  },
  {
    name: 'Resurrection Orb',
    sha256: 'ef8c39d782702899614fb8e31035302042c3f3f55ddf16c655dce339079c2734',
    clauseCount: 3,
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
