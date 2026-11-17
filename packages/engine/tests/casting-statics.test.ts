/**
 * Casting statics and replacements (engine-feature plan, PR 1): flash permissions ("you may cast
 * spells as though they had flash", CR 601.3b), spell cost increases (Thalia family, CR 601.2f),
 * damage multipliers and additions (CR 614.1a, 616.1), and life-gain replacements.
 *
 * Each line shape has an interpretation test on pinned Oracle text and near-miss negatives that
 * must stay unmodeled. Behavior goes through `computePriorityOptions` / `applyPriorityAction`, a
 * declared combat, or an activated ability, never a resolver called directly.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { YOURS, allOf, anyOf, not, ofColor, ofSubtype, ofType } from '../src/cards/selector';
import { runCombatPhase } from '../src/combat/combat';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  declareAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pinnedCards = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/casting-statics-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;

/** Pinned cards that must stay unmodeled: the near misses the plan names. */
const NEGATIVES = [
  'Timely Ward',
  'Radagast of Rhosgobel',
  'Kasmina, Enigmatic Mentor',
  'Jubilant Skybonder',
  'Lightning, Army of One',
];

/** Already-modeled pinned cards a regression test plays alongside. */
const SUPPORT = ['Pristine Talisman', 'Mutagenic Growth'];

function pinned(name: string): OracleCard {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry.card;
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

/** It is P1's turn, but `playerId` has priority with an empty stack (P1's upkeep-like window). */
function givePriority(ctx: GameContext, playerId: string, phase = 'precombatMain'): void {
  ctx.state.phase = phase as GameContext['state']['phase'];
  ctx.state.priorityPlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

function optionFor(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return 'objectId' in payload && payload.objectId === objectId;
  });
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome | undefined;

function take(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  targets: ReadonlyMap<number, string> = new Map(),
  answer?: Answer,
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }),
    answer,
    { strict: true },
  );
}

/** Every player passes; pending triggers go on the stack and resolve. */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(
    runPrioritySequence(ctx),
    (decision, count) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      if (pass >= 0) return { index: pass, targets: new Map() };
      return answer?.(decision, count) ?? { index: 0, targets: new Map() };
    },
    { strict: true },
  );
}

const mana = (symbols: string) =>
  [...symbols].map((symbol) => ({ symbol: symbol as 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }));

const lineCard = (oracleText: string, typeLine = 'Enchantment'): OracleCard =>
  oracle({ name: 'Line Probe', typeLine, manaCost: '{2}', oracleText });

const sorcery = (name = 'Lab Sorcery', manaCost = '{1}') =>
  oracle({ name, typeLine: 'Sorcery', manaCost, oracleText: 'Draw a card.' });

const bolt = (name = 'Lab Bolt', amount = 3) =>
  oracle({
    name,
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: `${name} deals ${amount} damage to any target.`,
  });

/** Cast `card` from P1's hand at `targetId` with enough red mana, and resolve it. */
function castBolt(
  ctx: GameContext,
  casterId: string,
  card: OracleCard,
  targetId: string,
  answer?: Answer,
) {
  const object = conjure(ctx, casterId, card, 'hand');
  addMana(playerById(ctx, casterId), mana('R'));
  const option = optionFor(ctx, casterId, object.id);
  expect(option, `${card.name} is offered`).toBeDefined();
  const decisions = take(
    ctx,
    casterId,
    option!.payload as PriorityActionPayload,
    new Map([[0, targetId]]),
  ).decisions;
  return [...decisions, ...settle(ctx, answer).decisions];
}

describe('cards these statics unblock', () => {
  it('casting-statics-pinned — the fixture matches its pins, and only the near misses refuse', () => {
    expect(pinnedCards.length).toBe(39 + NEGATIVES.length + SUPPORT.length);
    for (const { sha256, card } of pinnedCards) {
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
      const negative = NEGATIVES.includes(card.name);
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        if (negative) expect(def.unmodeledReasons.length, card.name).toBeGreaterThan(0);
        else expect(def.unmodeledReasons, `${card.name} ${candidate.oracleId}`).toEqual([]);
      }
      expect(getOverride(card.oracleId), card.name).toBeUndefined();
    }
  });
});

describe('flash permissions', () => {
  it('casting-statics-flash-ir — filters, any player, and the turn-long grant', () => {
    expect(interpretCard(pinned('Vedalken Orrery')).ruleStatics).toEqual([
      { kind: 'castAsThoughFlash' },
    ]);
    expect(interpretCard(pinned('Shimmer Myr')).ruleStatics).toEqual([
      { kind: 'castAsThoughFlash', filter: ofType('Artifact') },
    ]);
    expect(interpretCard(pinned("Yeva, Nature's Herald")).ruleStatics).toEqual([
      { kind: 'castAsThoughFlash', filter: allOf(ofColor('G'), ofType('Creature')) },
    ]);
    expect(interpretCard(pinned('Quick Sliver')).ruleStatics).toEqual([
      { kind: 'castAsThoughFlash', filter: ofSubtype('Sliver'), allPlayers: true },
    ]);
    expect(interpretCard(pinned('Whirlwing Stormbrood // Dynamic Soar')).ruleStatics).toEqual([
      { kind: 'castAsThoughFlash', filter: anyOf(ofType('Sorcery'), ofSubtype('Dragon')) },
    ]);
    expect(interpretCard(pinned("Raff Capashen, Ship's Mage")).ruleStatics).toEqual([
      {
        kind: 'castAsThoughFlash',
        filter: anyOf(
          ofType('Artifact'),
          { kind: 'supertype', value: 'Legendary' },
          ofSubtype('Saga'),
        ),
      },
    ]);
    expect(interpretCard(pinned('Tidal Barracuda')).ruleStatics[0]).toEqual({
      kind: 'castAsThoughFlash',
      allPlayers: true,
    });
    expect(interpretCard(pinned('Borne Upon a Wind')).spellAbility?.effects).toEqual([
      { op: 'castAsThoughFlashThisTurn' },
      { op: 'draw', count: { kind: 'const', n: 1 } },
    ]);
    // "This spell" forms are about one spell, and stay out of this shape.
    expect(
      interpretCard(
        lineCard('You may cast this spell as though it had flash if you control a Wizard.'),
      ).modeled,
    ).toBe(false);
  });

  it('casting-statics-orrery — a sorcery is offered and cast outside its timing only with it', () => {
    const ctx = pod('casting-statics-orrery');
    givePriority(ctx, 'P2');
    const spell = conjure(ctx, 'P2', sorcery(), 'hand');
    addMana(playerById(ctx, 'P2'), mana('C'));
    expect(optionFor(ctx, 'P2', spell.id)).toBeUndefined();

    spawn(ctx, 'P2', pinned('Vedalken Orrery'));
    const option = optionFor(ctx, 'P2', spell.id);
    expect(option?.data?.['instantSpeed']).toBe(true);
    take(ctx, 'P2', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack.map((entry) => entry.card?.name)).toEqual(['Lab Sorcery']);

    // It is P2's permission only, and it never lets a land be played.
    const other = conjure(ctx, 'P3', sorcery('Lab Other Sorcery'), 'hand');
    addMana(playerById(ctx, 'P3'), mana('C'));
    givePriority(ctx, 'P3');
    expect(optionFor(ctx, 'P3', other.id)).toBeUndefined();
    const land = conjure(ctx, 'P2', forest(), 'hand');
    givePriority(ctx, 'P2');
    expect(optionFor(ctx, 'P2', land.id)).toBeUndefined();
  });

  it('casting-statics-orrery-morph — a face-down spell is a creature spell it covers', () => {
    const ctx = pod('casting-statics-orrery-morph');
    givePriority(ctx, 'P2');
    const morph = conjure(
      ctx,
      'P2',
      oracle({ name: 'Lab Morph', manaCost: '{4}{G}', oracleText: 'Morph {G}' }),
      'hand',
    );
    addMana(playerById(ctx, 'P2'), mana('CCC'));
    const faceDown = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P2')).find(
        (option) =>
          (option.payload as { objectId?: string; alternativeCast?: string }).objectId ===
            morph.id &&
          (option.payload as { alternativeCast?: string }).alternativeCast === 'faceDown',
      );
    expect(faceDown()).toBeUndefined();
    spawn(ctx, 'P2', pinned('Vedalken Orrery'));
    const option = faceDown();
    expect(option).toBeDefined();
    take(ctx, 'P2', option!.payload as PriorityActionPayload);
    expect(ctx.state.stack).toHaveLength(1);
    expect(playerById(ctx, 'P2').manaEntries).toHaveLength(0);
  });

  it('casting-statics-shimmer-myr — the filter: an artifact spell flashes, a creature does not', () => {
    const ctx = pod('casting-statics-shimmer');
    givePriority(ctx, 'P2');
    spawn(ctx, 'P2', pinned('Shimmer Myr'));
    const creature = conjure(ctx, 'P2', oracle({ name: 'Lab Bear', manaCost: '{1}' }), 'hand');
    const rock = conjure(
      ctx,
      'P2',
      oracle({ name: 'Lab Rock', typeLine: 'Artifact', manaCost: '{1}' }),
      'hand',
    );
    addMana(playerById(ctx, 'P2'), mana('C'));
    expect(optionFor(ctx, 'P2', creature.id)).toBeUndefined();
    expect(optionFor(ctx, 'P2', rock.id)).toBeDefined();
  });

  it('casting-statics-barracuda — "any player" covers opponents', () => {
    const ctx = pod('casting-statics-barracuda');
    spawn(ctx, 'P1', pinned('Tidal Barracuda'));
    // P2 on its own turn, in its upkeep: the permission is P2's too.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    givePriority(ctx, 'P2', 'beginning');
    const spell = conjure(ctx, 'P2', sorcery(), 'hand');
    addMana(playerById(ctx, 'P2'), mana('C'));
    expect(optionFor(ctx, 'P2', spell.id)).toBeDefined();
  });

  it('casting-statics-emergence-zone — the turn-long permission ends with the turn', () => {
    const ctx = pod('casting-statics-zone');
    const zone = spawn(ctx, 'P2', pinned('Emergence Zone'));
    givePriority(ctx, 'P2');
    const spell = conjure(ctx, 'P2', sorcery(), 'hand');
    addMana(playerById(ctx, 'P2'), mana('CC'));
    expect(optionFor(ctx, 'P2', spell.id)).toBeUndefined();

    const activate = computePriorityOptions(ctx, playerById(ctx, 'P2')).find(
      (option) =>
        option.type === 'activateAbility' &&
        (option.payload as { objectId?: string }).objectId === zone.id &&
        option.description.includes('as though they had flash'),
    );
    expect(activate).toBeDefined();
    take(ctx, 'P2', activate!.payload as PriorityActionPayload);
    settle(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Emergence Zone')).toBe(false);
    givePriority(ctx, 'P2');
    expect(optionFor(ctx, 'P2', spell.id)).toBeDefined();

    // Cleanup ends "this turn" (CR 514.2).
    endUntilEotEffects(ctx);
    expect(optionFor(ctx, 'P2', spell.id)).toBeUndefined();
  });
});

describe('spell cost increases', () => {
  it('casting-statics-cost-ir — filters, opponents only, and the caster-turn exception', () => {
    expect(interpretCard(pinned('Thalia, Guardian of Thraben')).ruleStatics).toEqual([
      { kind: 'spellCostIncrease', amount: 1, filter: not(ofType('Creature')) },
    ]);
    expect(interpretCard(pinned('Lodestone Golem')).ruleStatics).toEqual([
      { kind: 'spellCostIncrease', amount: 1, filter: not(ofType('Artifact')) },
    ]);
    expect(interpretCard(pinned('Aura of Silence')).ruleStatics).toEqual([
      {
        kind: 'spellCostIncrease',
        amount: 2,
        filter: anyOf(ofType('Artifact'), ofType('Enchantment')),
        opponentsOnly: true,
      },
    ]);
    expect(interpretCard(pinned('Sphere of Resistance')).ruleStatics).toEqual([
      { kind: 'spellCostIncrease', amount: 1 },
    ]);
    expect(interpretCard(pinned('Defense Grid')).ruleStatics).toEqual([
      { kind: 'spellCostIncrease', amount: 3, exceptCastersTurn: true },
    ]);
    expect(interpretCard(pinned('Grand Arbiter Augustin IV')).ruleStatics[2]).toEqual({
      kind: 'spellCostIncrease',
      amount: 1,
      opponentsOnly: true,
    });
    // "Spells you cast cost more" is not a printed shape this reads.
    expect(interpretCard(lineCard('Creature spells you cast cost {1} more to cast.')).modeled).toBe(
      false,
    );
  });

  it('casting-statics-thalia — a noncreature spell costs {1} more, a creature spell does not', () => {
    const ctx = pod('casting-statics-thalia');
    spawn(ctx, 'P2', pinned('Thalia, Guardian of Thraben'));
    const spell = conjure(ctx, 'P1', sorcery(), 'hand');
    const bear = conjure(ctx, 'P1', oracle({ name: 'Lab Bear', manaCost: '{1}' }), 'hand');
    addMana(playerById(ctx, 'P1'), mana('C'));
    expect(optionFor(ctx, 'P1', spell.id)).toBeUndefined();
    expect(optionFor(ctx, 'P1', bear.id)).toBeDefined();
    addMana(playerById(ctx, 'P1'), mana('C'));
    const option = optionFor(ctx, 'P1', spell.id);
    expect(option?.data?.['manaCost']).toBe('{2}');
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    // Both mana went to the {1} spell and Thalia's {1}; the mana value is still 1.
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.stack[0]?.card?.name).toBe('Lab Sorcery');
  });

  it('casting-statics-sphere-commander — the increase adds to the commander tax', () => {
    const ctx = pod('casting-statics-sphere-commander');
    spawn(ctx, 'P2', pinned('Sphere of Resistance'));
    const commander = conjure(
      ctx,
      'P1',
      oracle({ name: 'Lab Lord', typeLine: 'Legendary Creature — Human', manaCost: '{1}' }),
      'command',
      { isCommander: true },
    );
    playerById(ctx, 'P1').commanderCardIds.push(commander.cardId);
    playerById(ctx, 'P1').commanderCastCount[commander.cardId] = 1;
    // {1} + tax {2} + Sphere {1} = {4}.
    addMana(playerById(ctx, 'P1'), mana('CCC'));
    expect(optionFor(ctx, 'P1', commander.id)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), mana('C'));
    expect(optionFor(ctx, 'P1', commander.id)?.data?.['manaCost']).toBe('{4}');
  });

  it('casting-statics-thalia-free-cast — a spell cast without paying its mana cost still pays {1}', () => {
    const run = (extra: string) => {
      const ctx = pod('casting-statics-thalia-free');
      spawn(ctx, 'P2', pinned('Thalia, Guardian of Thraben'));
      // The hit on top of a few lands, so its draw has a card to draw.
      playerById(ctx, 'P1').library.length = 0;
      for (let n = 0; n < 3; n++) conjure(ctx, 'P1', forest(), 'library');
      conjure(ctx, 'P1', sorcery('Lab Cascade Hit', '{2}'), 'library');
      const cascader = conjure(
        ctx,
        'P1',
        oracle({ name: 'Lab Cascader', manaCost: '{4}', oracleText: 'Cascade' }),
        'hand',
      );
      addMana(playerById(ctx, 'P1'), mana(`CCCC${extra}`));
      take(ctx, 'P1', optionFor(ctx, 'P1', cascader.id)!.payload as PriorityActionPayload);
      const offered: string[] = [];
      settle(ctx, (decision) => {
        const free = decision.options.findIndex((option) => option.type === 'castFree');
        if (free < 0) return undefined;
        offered.push(decision.options[free]!.description);
        return { index: free, targets: new Map() };
      });
      return { ctx, offered };
    };
    // With no mana left, the free cast can't pay Thalia's {1}.
    expect(run('').offered).toEqual([]);
    const paid = run('C');
    expect(paid.offered).toHaveLength(1);
    expect(playerById(paid.ctx, 'P1').manaEntries).toHaveLength(0);
    expect(playerById(paid.ctx, 'P1').graveyard.map((card) => card.name)).toContain(
      'Lab Cascade Hit',
    );
  });

  it('casting-statics-increase-then-reduction — the increase applies first (CR 601.2f)', () => {
    const ctx = pod('casting-statics-order');
    spawn(ctx, 'P2', pinned('Thalia, Guardian of Thraben'));
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Medallion',
        typeLine: 'Artifact',
        manaCost: '{2}',
        oracleText: 'Blue spells you cast cost {1} less to cast.',
      }),
    );
    // {U}: Thalia makes it {1}{U}, then the reduction takes the {1} back. Reducing first would
    // find no generic mana to take and leave {1}{U}.
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Lab Ponder',
        typeLine: 'Sorcery',
        manaCost: '{U}',
        colors: ['U'],
        oracleText: 'Draw a card.',
      }),
      'hand',
    );
    addMana(playerById(ctx, 'P1'), mana('U'));
    expect(optionFor(ctx, 'P1', spell.id)?.data?.['manaCost']).toBe('{U}');
  });

  it("casting-statics-defense-grid — off during the caster's turn, {3} more otherwise", () => {
    const ctx = pod('casting-statics-grid');
    spawn(ctx, 'P1', pinned('Defense Grid'));
    const flash = oracle({
      name: 'Lab Flash',
      typeLine: 'Instant',
      manaCost: '{1}',
      oracleText: 'Draw a card.',
    });
    const mine = conjure(ctx, 'P1', flash, 'hand');
    addMana(playerById(ctx, 'P1'), mana('C'));
    expect(optionFor(ctx, 'P1', mine.id)?.data?.['manaCost']).toBe('{1}');

    // The Grid's own controller is taxed on another player's turn too.
    const theirs = conjure(ctx, 'P2', flash, 'hand');
    givePriority(ctx, 'P2');
    addMana(playerById(ctx, 'P2'), mana('CCC'));
    expect(optionFor(ctx, 'P2', theirs.id)).toBeUndefined();
    addMana(playerById(ctx, 'P2'), mana('C'));
    expect(optionFor(ctx, 'P2', theirs.id)?.data?.['manaCost']).toBe('{4}');
  });

  it('casting-statics-opponents-only — Grand Arbiter taxes opponents, not its controller', () => {
    const ctx = pod('casting-statics-arbiter');
    spawn(ctx, 'P1', pinned("God-Pharaoh's Statue"));
    const mine = conjure(ctx, 'P1', sorcery(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('C'));
    expect(optionFor(ctx, 'P1', mine.id)?.data?.['manaCost']).toBe('{1}');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    givePriority(ctx, 'P2');
    const theirs = conjure(ctx, 'P2', sorcery('Lab Their Sorcery'), 'hand');
    addMana(playerById(ctx, 'P2'), mana('CCC'));
    expect(optionFor(ctx, 'P2', theirs.id)?.data?.['manaCost']).toBe('{3}');
  });
});

describe('damage replacements', () => {
  it('casting-statics-damage-ir — source filters, recipients, combat, factors and additions', () => {
    expect(interpretCard(pinned('Torbran, Thane of Red Fell')).ruleStatics).toEqual([
      {
        kind: 'damageReplacement',
        sourceFilter: allOf(ofColor('R'), YOURS),
        recipient: 'opponents',
        plus: 2,
      },
    ]);
    expect(interpretCard(pinned('Solphim, Mayhem Dominus')).ruleStatics).toEqual([
      {
        kind: 'damageReplacement',
        sourceFilter: YOURS,
        recipient: 'opponents',
        noncombatOnly: true,
        factor: 2,
      },
    ]);
    expect(interpretCard(pinned('Fiendish Duo')).ruleStatics).toEqual([
      { kind: 'damageReplacement', recipient: 'opponentPlayers', factor: 2 },
    ]);
    expect(interpretCard(pinned('Tor Wauki the Younger')).ruleStatics).toEqual([
      {
        kind: 'damageReplacement',
        sourceFilter: YOURS,
        excludesSelf: true,
        recipient: 'any',
        noncombatOnly: true,
        plus: 1,
      },
    ]);
    expect(interpretCard(pinned('Fiery Emancipation')).ruleStatics).toEqual([
      { kind: 'damageReplacement', sourceFilter: YOURS, recipient: 'any', factor: 3 },
    ]);
    expect(interpretCard(pinned('Valley Flamecaller')).ruleStatics).toEqual([
      {
        kind: 'damageReplacement',
        sourceFilter: allOf(
          anyOf(ofSubtype('Lizard'), ofSubtype('Mouse'), ofSubtype('Otter'), ofSubtype('Raccoon')),
          YOURS,
        ),
        permanentSource: true,
        recipient: 'any',
        plus: 1,
      },
    ]);
    expect(interpretCard(pinned('Gratuitous Violence')).ruleStatics).toEqual([
      {
        kind: 'damageReplacement',
        sourceFilter: allOf(ofType('Creature'), YOURS),
        permanentSource: true,
        recipient: 'any',
        factor: 2,
      },
    ]);
    // A duration ("until your next turn") or a named player is a different effect.
    expect(
      interpretCard(
        lineCard(
          'If a source would deal damage to target player this turn, it deals double that damage instead.',
        ),
      ).modeled,
    ).toBe(false);
  });

  it('casting-statics-creature-not-source — "a creature you control" is a permanent (CR 109.2)', () => {
    // A creature card's channel ability deals its damage from P1's graveyard: the card is a
    // creature source, but not a creature P1 controls, so Gratuitous Violence leaves it at 2.
    const ctx = pod('casting-statics-creature-not-source');
    spawn(ctx, 'P1', pinned('Gratuitous Violence'));
    const channeler = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Lab Channeler',
        typeLine: 'Creature — Human Archer',
        manaCost: '{2}{R}',
        colors: ['R'],
        oracleText: 'Channel — {R}, Discard Lab Channeler: It deals 2 damage to any target.',
      }),
      'hand',
    );
    addMana(playerById(ctx, 'P1'), mana('R'));
    const channel = optionFor(ctx, 'P1', channeler.id);
    expect(channel).toBeDefined();
    take(ctx, 'P1', channel!.payload as PriorityActionPayload, new Map([[0, 'P2']]));
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(38);
    // A creature permanent P1 controls still deals double.
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Archer',
        typeLine: 'Creature — Human Archer',
        manaCost: '{R}',
        colors: ['R'],
        oracleText: '{T}: Lab Archer deals 1 damage to any target.',
      }),
      { summoningSick: false },
    );
    const shot = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (option) => option.type === 'activateAbility' && option.description.includes('Lab Archer'),
    );
    take(ctx, 'P1', shot!.payload as PriorityActionPayload, new Map([[0, 'P2']]));
    settle(ctx);
    expect(playerById(ctx, 'P2').life).toBe(36);
  });

  it('casting-statics-two-doublers — two doublers make four times the damage', () => {
    const ctx = pod('casting-statics-doublers');
    spawn(ctx, 'P3', pinned('Furnace of Rath'));
    spawn(ctx, 'P4', pinned('Dictate of the Twin Gods'));
    castBolt(ctx, 'P1', bolt(), 'P2');
    expect(playerById(ctx, 'P2').life).toBe(40 - 12);
  });

  it("casting-statics-triple — Fiery Emancipation triples only its controller's sources", () => {
    const ctx = pod('casting-statics-triple');
    spawn(ctx, 'P1', pinned('Fiery Emancipation'));
    castBolt(ctx, 'P1', bolt(), 'P2');
    expect(playerById(ctx, 'P2').life).toBe(40 - 9);
    castBolt(ctx, 'P3', bolt('Lab Their Bolt'), 'P2');
    expect(playerById(ctx, 'P2').life).toBe(40 - 9 - 3);
  });

  it('casting-statics-torbran — plus 2 per damage event, to opponents and their permanents only', () => {
    const ctx = pod('casting-statics-torbran');
    spawn(ctx, 'P1', pinned('Torbran, Thane of Red Fell'));
    castBolt(ctx, 'P1', bolt('Lab Ping', 1), 'P2');
    expect(playerById(ctx, 'P2').life).toBe(40 - 3);
    // Your own creature is not "a permanent an opponent controls".
    const mine = spawn(ctx, 'P1', oracle({ name: 'Lab Wall', power: '0', toughness: '5' }));
    castBolt(ctx, 'P1', bolt('Lab Ping Two', 1), mine.id);
    expect(mine.damageMarked).toBe(1);
    // A nonred source is not Torbran's.
    const gray = oracle({
      name: 'Lab Gray Ping',
      typeLine: 'Instant',
      manaCost: '{R}',
      oracleText: 'Lab Gray Ping deals 1 damage to any target.',
    });
    castBolt(ctx, 'P1', gray, 'P3');
    expect(playerById(ctx, 'P3').life).toBe(39);
  });

  it('casting-statics-torbran-and-doubler — the damaged player orders them (CR 616.1)', () => {
    const run = (first: RegExp) => {
      const ctx = pod('casting-statics-order-damage');
      spawn(ctx, 'P1', pinned('Torbran, Thane of Red Fell'));
      spawn(ctx, 'P1', pinned("Angrath's Marauders"));
      const asked: string[] = [];
      castBolt(ctx, 'P1', bolt('Lab Ping', 1), 'P2', (decision) => {
        if (!decision.options.some((option) => option.type === 'damageModifier')) return undefined;
        asked.push(decision.player);
        return {
          index: decision.options.findIndex((option) => first.test(option.description)),
          targets: new Map(),
        };
      });
      return { life: playerById(ctx, 'P2').life, asked, log: ctx.state.eventLog.length };
    };
    const plusFirst = run(/plus 2/);
    const doubleFirst = run(/double/);
    expect(plusFirst.asked).toEqual(['P2']);
    // (1 + 2) * 2 = 6 against 1 * 2 + 2 = 4.
    expect(plusFirst.life).toBe(34);
    expect(doubleFirst.life).toBe(36);
    // The same answers replay to the same game.
    expect(run(/plus 2/)).toEqual(plusFirst);
  });

  it('casting-statics-solphim — noncombat damage only', () => {
    const ctx = pod('casting-statics-solphim');
    spawn(ctx, 'P1', pinned('Solphim, Mayhem Dominus'));
    castBolt(ctx, 'P1', bolt(), 'P2');
    expect(playerById(ctx, 'P2').life).toBe(34);

    const attacker = spawn(ctx, 'P1', oracle({ name: 'Lab Brute', power: '3', toughness: '3' }));
    attacker.summoningSick = false;
    ctx.state.phase = 'combat';
    pump(
      runCombatPhase(ctx),
      (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, (id) => (id === attacker.id ? 'P2' : null));
        if (decision.decisionType === 'declareBlockers') return declareNoBlocks(decision);
        return undefined;
      },
      { strict: true },
    );
    expect(playerById(ctx, 'P2').life).toBe(31);
  });

  it('casting-statics-tor-wauki — another source only, and noncombat only', () => {
    const ctx = pod('casting-statics-tor-wauki');
    spawn(ctx, 'P1', pinned('Tor Wauki the Younger'));
    // Casting the instant triggers Tor Wauki: its own 2 damage, aimed at P3, is not "another
    // source", so it stays 2; the instant's 1 becomes 2.
    castBolt(ctx, 'P1', bolt('Lab Ping', 1), 'P2', (decision) =>
      decision.options.some((option) => option.type === 'chooseTargets')
        ? { index: 0, targets: new Map([[0, 'P3']]) }
        : undefined,
    );
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(playerById(ctx, 'P3').life).toBe(38);
    expect(playerById(ctx, 'P4').life).toBe(40);
  });

  it("casting-statics-tor-wauki-new-object — Tor Wauki's earlier object is another source", () => {
    // Tor Wauki's trigger has fired when it leaves and returns (CR 400.7): the returned
    // Tor Wauki is a new object, so the old one's 2 damage is another source's and becomes 3.
    const ctx = pod('casting-statics-tor-wauki-new-object');
    const tor = spawn(ctx, 'P1', pinned('Tor Wauki the Younger'));
    const ping = conjure(ctx, 'P1', bolt('Lab Ping', 1), 'hand');
    addMana(playerById(ctx, 'P1'), mana('R'));
    take(
      ctx,
      'P1',
      optionFor(ctx, 'P1', ping.id)!.payload as PriorityActionPayload,
      new Map([[0, 'P2']]),
    );
    const exiled = pump(moveObject(ctx, tor, { zone: 'exile' }), undefined, { strict: true });
    pump(moveObject(ctx, exiled.value!, { zone: 'battlefield', controllerId: 'P1' }), undefined, {
      strict: true,
    });
    const back = ctx.state.battlefield.find((perm) => perm.name === 'Tor Wauki the Younger');
    expect(back).toBeDefined();
    expect(back!.id).not.toBe(tor.id);
    settle(ctx, (decision) =>
      decision.options.some((option) => option.type === 'chooseTargets')
        ? { index: 0, targets: new Map([[0, 'P3']]) }
        : undefined,
    );
    expect(playerById(ctx, 'P3').life).toBe(37);
    expect(playerById(ctx, 'P2').life).toBe(38);
  });

  it('casting-statics-source-last-controller — a gone source keeps its last controller', () => {
    // P1 activates its rod, then P2 gains control of it and it leaves the battlefield. The rod
    // was last controlled by P2 (CR 113.7a), so P1's Fiery Emancipation does not triple it.
    const ctx = pod('casting-statics-source-last-controller');
    spawn(ctx, 'P1', pinned('Fiery Emancipation'));
    const rod = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Rod',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{T}: Lab Rod deals 1 damage to any target.',
      }),
    );
    const activate = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (option) => option.type === 'activateAbility' && option.description.includes('Lab Rod'),
    );
    expect(activate).toBeDefined();
    take(ctx, 'P1', activate!.payload as PriorityActionPayload, new Map([[0, 'P2']]));
    // With the ability on the stack: a stand-in for a resolved control change (Threaten), then
    // a sacrifice.
    expect(ctx.state.stack).toHaveLength(1);
    rod.controllerId = 'P2';
    pump(moveObject(ctx, rod, { zone: 'graveyard', reason: 'sacrifice' }), undefined, {
      strict: true,
    });
    settle(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Lab Rod')).toBe(false);
    expect(playerById(ctx, 'P2').life).toBe(39);
  });
});

describe('life-gain replacements', () => {
  const healer = () =>
    oracle({
      name: 'Lab Healer',
      typeLine: 'Instant',
      manaCost: '{W}',
      colors: ['W'],
      oracleText: 'You gain 3 life.',
    });

  function castHeal(ctx: GameContext, answer?: Answer) {
    const object = conjure(ctx, 'P1', healer(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('W'));
    const option = optionFor(ctx, 'P1', object.id);
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    return settle(ctx, answer);
  }

  it('casting-statics-life-ir — twice, and plus N', () => {
    expect(interpretCard(pinned('Rhox Faithmender')).ruleStatics).toEqual([
      { kind: 'lifeGainReplacement', factor: 2 },
    ]);
    expect(interpretCard(pinned("Knight of Dawn's Light")).ruleStatics).toEqual([
      { kind: 'lifeGainReplacement', plus: 1 },
    ]);
    // "Each player" or an opponent's gain is a different replacement.
    expect(
      interpretCard(lineCard('If an opponent would gain life, that player gains no life instead.'))
        .modeled,
    ).toBe(false);
  });

  it('casting-statics-faithmender — one replaced gain event, seen once at the final amount', () => {
    const ctx = pod('casting-statics-faithmender');
    spawn(ctx, 'P1', pinned('Rhox Faithmender'));
    spawn(ctx, 'P2', pinned('Boon Reflection'));
    castHeal(ctx);
    // Only P1's own replacement applies to P1's gain.
    expect(playerById(ctx, 'P1').life).toBe(46);
    const gains = ctx.state.eventLog.filter((event) => event.type === 'lifeGain');
    expect(gains.map((event) => event.payload['amount'])).toEqual([6]);
  });

  it('casting-statics-faithmender-lifelink — each lifelink event is replaced', () => {
    const ctx = pod('casting-statics-lifelink');
    spawn(ctx, 'P1', pinned('Rhox Faithmender'));
    const attacker = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lab Lifelinker', oracleText: 'Lifelink', power: '2', toughness: '2' }),
    );
    attacker.summoningSick = false;
    ctx.state.phase = 'combat';
    pump(
      runCombatPhase(ctx),
      (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, (id) => (id === attacker.id ? 'P2' : null));
        if (decision.decisionType === 'declareBlockers') return declareNoBlocks(decision);
        return undefined;
      },
      { strict: true },
    );
    expect(playerById(ctx, 'P1').life).toBe(44);
  });

  it('casting-statics-life-order — "plus 1" and "twice": the gaining player orders them', () => {
    const run = (first: RegExp) => {
      const ctx = pod('casting-statics-life-order');
      spawn(ctx, 'P1', pinned('Rhox Faithmender'));
      spawn(ctx, 'P1', pinned("Knight of Dawn's Light"));
      const asked: string[] = [];
      castHeal(ctx, (decision) => {
        if (!decision.options.some((option) => option.type === 'lifeGainReplacement'))
          return undefined;
        asked.push(decision.player);
        return {
          index: decision.options.findIndex((option) => first.test(option.description)),
          targets: new Map(),
        };
      });
      return { life: playerById(ctx, 'P1').life, asked, log: ctx.state.eventLog.length };
    };
    const plusFirst = run(/plus 1/);
    expect(plusFirst.asked).toEqual(['P1']);
    expect(plusFirst.life).toBe(48);
    expect(run(/twice/).life).toBe(47);
    // The same answer replays to the same game.
    expect(run(/plus 1/)).toEqual(plusFirst);
  });
  it("casting-statics-life-order-in-payment — a mana ability's replaced gain can pay life", () => {
    // At 1 life, Pristine Talisman's gain becomes 3 or 4 life under Rhox Faithmender and Knight
    // of Dawn's Light, whichever order P1 picks, so its {C} plus 2 life pays for Mutagenic Growth's
    // {G/P}. The planner proves it from the smaller gain; the cast asks P1 for the order.
    const ctx = pod('casting-statics-life-payment');
    playerById(ctx, 'P1').life = 1;
    spawn(ctx, 'P1', pinned('Pristine Talisman'));
    spawn(ctx, 'P1', pinned('Rhox Faithmender'));
    spawn(ctx, 'P1', pinned("Knight of Dawn's Light"));
    const target = spawn(ctx, 'P1', oracle({ name: 'Lab Bear' }));
    const growth = conjure(ctx, 'P1', pinned('Mutagenic Growth'), 'hand');
    const options = computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return 'objectId' in payload && payload.objectId === growth.id;
    });
    expect(options.length).toBeGreaterThan(0);
    const asked: string[] = [];
    take(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      new Map([[0, target.id]]),
      (decision) => {
        if (decision.options.some((option) => option.type === 'lifeGainReplacement')) {
          asked.push(decision.player);
          return { index: 0, targets: new Map() };
        }
        return undefined;
      },
    );
    expect(ctx.state.stack[0]?.card?.name).toBe('Mutagenic Growth');
    expect(asked).toEqual(['P1']);
    // 1 + (3 or 4) - 2.
    expect([2, 3]).toContain(playerById(ctx, 'P1').life);
  });
  it('casting-statics-life-order-in-payment-witness — a payment needing the bigger gain keeps its order', () => {
    // At 2 life, Pristine Talisman's gain is 4 if Knight of Dawn's Light's "plus 1" applies first
    // and 3 if Rhox Faithmender's "twice" does. Only 6 life pays three {G/P} pips, so the cast is
    // legal through the plus-first order alone, and paying it applies that order without asking.
    const ctx = pod('casting-statics-life-payment-witness');
    playerById(ctx, 'P1').life = 2;
    spawn(ctx, 'P1', pinned('Pristine Talisman'));
    spawn(ctx, 'P1', pinned('Rhox Faithmender'));
    spawn(ctx, 'P1', pinned("Knight of Dawn's Light"));
    const ritual = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Lab Phyrexian Draw',
        typeLine: 'Instant',
        manaCost: '{G/P}{G/P}{G/P}',
        cmc: 3,
        oracleText: 'Draw a card.',
      }),
      'hand',
    );
    const options = computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return 'objectId' in payload && payload.objectId === ritual.id;
    });
    expect(options.length).toBeGreaterThan(0);
    const asked: string[] = [];
    take(ctx, 'P1', options[0]!.payload as PriorityActionPayload, new Map(), (decision) => {
      if (decision.options.some((option) => option.type === 'lifeGainReplacement'))
        asked.push(decision.player);
      return undefined;
    });
    expect(ctx.state.stack[0]?.card?.name).toBe('Lab Phyrexian Draw');
    expect(asked).toEqual([]);
    // 2 + (1 + 1) * 2 - 6.
    expect(playerById(ctx, 'P1').life).toBe(0);
  });
});
