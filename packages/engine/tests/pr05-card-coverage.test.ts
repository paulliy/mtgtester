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
import { runCombatAndExtraCombats } from '../src/turn/turn';
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
