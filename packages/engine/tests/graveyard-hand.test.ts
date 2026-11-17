/**
 * Graveyard and hand abilities (engine-feature plan, PR 3): transmute (CR 702.53), an activated
 * "return this card from your graveyard to the battlefield" (CR 113.6), embalm and eternalize
 * (CR 702.128, 702.129), and the Colossus replacement "if ~ would be put into a graveyard from
 * anywhere, reveal ~ and shuffle it into its owner's library instead" (CR 614.1a), and Spirit
 * Guides' mana ability from the hand (CR 605.1a).
 *
 * Each line shape has an interpretation test on pinned Oracle text and near-miss negatives that
 * must stay unmodeled. Behavior goes through `computePriorityOptions` / `applyPriorityAction` and
 * spells cast and resolved through priority, never a resolver called directly.
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
import { allOf, ofSupertype, ofType } from '../src/cards/selector';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { computeCharacteristics } from '../src/effects/continuous';
import type { EngineCardObject, GameContext } from '../src/state/types';
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
  pumpStrict,
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pinnedCards = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/graveyard-hand-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;

/** Pinned cards that must stay unmodeled: the near misses and the lines this batch leaves out. */
const NEGATIVES = [
  'Cauldron Familiar',
  'Cult Conscript',
  'Grafted Butcher',
  'Squee, Goblin Nabob',
  'Phoenix Chick',
  'Sword of the Meek',
];

/** Already-modeled pinned cards the behavior tests play alongside. */
const SUPPORT = ['Rest in Peace', 'Counterspell', 'Thoughtseize'];

/** An edict: each opponent sacrifices a creature, through the batch departure path. */
const edict = (): OracleCard =>
  oracle({
    name: 'Lab Edict',
    typeLine: 'Sorcery',
    manaCost: '{1}{B}',
    oracleText: 'Each opponent sacrifices a creature.',
  });

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

function givePriority(ctx: GameContext, playerId: string, phase = 'precombatMain'): void {
  ctx.state.phase = phase as GameContext['state']['phase'];
  ctx.state.priorityPlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

function optionsFor(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return 'objectId' in payload && payload.objectId === objectId;
  });
}

function optionFor(ctx: GameContext, playerId: string, objectId: string) {
  return optionsFor(ctx, playerId, objectId)[0];
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

const lineCard = (oracleText: string, typeLine = 'Creature — Skeleton'): OracleCard =>
  oracle({
    name: 'Line Probe',
    typeLine,
    manaCost: '{1}{B}',
    oracleText,
    power: '1',
    toughness: '1',
  });

const card = (name: string, manaCost: string, typeLine = 'Sorcery'): OracleCard =>
  oracle({ name, typeLine, manaCost, oracleText: typeLine === 'Sorcery' ? 'Draw a card.' : '' });

const zoneOf = (ctx: GameContext, cardId: string): string | undefined => {
  if (ctx.state.battlefield.some((p) => p.cardId === cardId)) return 'battlefield';
  if (ctx.state.exile.some((c) => c.cardId === cardId)) return 'exile';
  for (const player of ctx.state.players) {
    if (player.hand.some((c) => c.cardId === cardId)) return 'hand';
    if (player.graveyard.some((c) => c.cardId === cardId)) return 'graveyard';
    if (player.library.some((c) => c.cardId === cardId)) return 'library';
  }
  return undefined;
};

describe('cards this batch unblocks', () => {
  it('graveyard-hand-pinned — the fixture matches its pins, and only the near misses refuse', () => {
    expect(pinnedCards.length).toBe(27 + NEGATIVES.length + SUPPORT.length);
    for (const { sha256, card } of pinnedCards) {
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
      const negative = NEGATIVES.includes(card.name);
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        if (negative) expect(def.unmodeledReasons.length, card.name).toBeGreaterThan(0);
        else expect(def.unmodeledReasons, `${card.name} ${candidate.oracleId}`).toEqual([]);
      }
      if (!SUPPORT.includes(card.name))
        expect(getOverride(card.oracleId), card.name).toBeUndefined();
    }
  });
});

describe('transmute', () => {
  it('graveyard-hand-transmute-ir — a sorcery-speed hand ability that discards as a cost', () => {
    expect(
      interpretCard(pinned('Drift of Phantasms')).activatedAbilities.find((a) => a.zone === 'hand'),
    ).toEqual({
      costs: [
        {
          kind: 'mana',
          cost: { generic: 1, colored: { W: 0, U: 2, B: 0, R: 0, G: 0 }, colorless: 0 },
        },
        { kind: 'discardSelf' },
      ],
      timing: 'sorcery',
      zone: 'hand',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf({ kind: 'manaValueAtLeast', n: 3 }, { kind: 'manaValueAtMost', n: 3 }),
            destinations: [{ zone: 'hand' }],
            reveal: true,
            allowFailToFind: true,
          },
          { op: 'shuffle' },
        ],
        description: expect.stringMatching(/^Transmute \{1\}\{U\}\{U\}/),
      },
    });
    // Tolaria West is a land: mana value 0.
    const west = interpretCard(pinned('Tolaria West')).activatedAbilities.find(
      (a) => a.zone === 'hand',
    );
    expect(west?.ability.effects[0]).toMatchObject({
      filter: allOf({ kind: 'manaValueAtLeast', n: 0 }, { kind: 'manaValueAtMost', n: 0 }),
    });
  });

  it('graveyard-hand-transmute — finds only an equal mana value, reveals it, sorcery speed only', () => {
    const ctx = pod('graveyard-hand-transmute');
    const p1 = playerById(ctx, 'P1');
    const drift = conjure(ctx, 'P1', pinned('Drift of Phantasms'), 'hand');
    const three = conjure(ctx, 'P1', card('Lab Three', '{2}{U}'), 'library');
    const two = conjure(ctx, 'P1', card('Lab Two', '{1}{U}'), 'library');
    addMana(p1, mana('UUC'));

    // Not at instant speed: in its own upkeep it is not offered.
    givePriority(ctx, 'P1', 'beginning');
    expect(optionFor(ctx, 'P1', drift.id)).toBeUndefined();
    givePriority(ctx, 'P1');

    const option = optionsFor(ctx, 'P1', drift.id).find((o) => o.type === 'activateAbility');
    expect(option?.data?.['sourceZone']).toBe('hand');
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    // The discard is the cost: the card is in the graveyard while the ability waits.
    expect(zoneOf(ctx, drift.cardId)).toBe('graveyard');
    expect(ctx.state.stack).toHaveLength(1);

    const offered: string[][] = [];
    settle(ctx, (decision) => {
      offered.push(decision.options.map((o) => o.description));
      const index = decision.options.findIndex((o) => o.description.includes('Lab Three'));
      return { index: Math.max(index, 0), targets: new Map() };
    });
    expect(offered.flat().some((d) => d.includes('Lab Two'))).toBe(false);
    expect(zoneOf(ctx, three.cardId)).toBe('hand');
    expect(zoneOf(ctx, two.cardId)).toBe('library');
    const found = ctx.state.eventLog.find((e) => e.type === 'searchFound');
    expect(found?.payload).toMatchObject({ name: 'Lab Three', revealed: true });
  });

  it('graveyard-hand-transmute-opponent-turn — not offered on another player’s turn', () => {
    const ctx = pod('graveyard-hand-transmute-turn');
    const drift = conjure(ctx, 'P2', pinned('Drift of Phantasms'), 'hand');
    addMana(playerById(ctx, 'P2'), mana('UUC'));
    givePriority(ctx, 'P2');
    expect(optionFor(ctx, 'P2', drift.id)).toBeUndefined();
  });
});

describe('return this card from your graveyard to the battlefield', () => {
  it('graveyard-hand-return-ir — tapped, conditions and counters', () => {
    expect(interpretCard(pinned('Reassembling Skeleton')).activatedAbilities).toEqual([
      {
        costs: [
          {
            kind: 'mana',
            cost: { generic: 1, colored: { W: 0, U: 0, B: 1, R: 0, G: 0 }, colorless: 0 },
          },
        ],
        timing: 'any',
        zone: 'graveyard',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'returnSelfFromGraveyardToBattlefield', tapped: true }],
          description: '{1}{B}: Return this card from your graveyard to the battlefield tapped.',
        },
      },
    ]);
    expect(interpretCard(pinned('Bloodsoaked Champion')).activatedAbilities[0]).toMatchObject({
      zone: 'graveyard',
      condition: { kind: 'youAttackedThisTurn' },
      ability: { effects: [{ op: 'returnSelfFromGraveyardToBattlefield' }] },
    });
    expect(interpretCard(pinned('Haunt of the Dead Marshes')).activatedAbilities[0]).toMatchObject({
      zone: 'graveyard',
      condition: {
        kind: 'countPermanents',
        selector: allOf(ofSupertype('Legendary'), ofType('Creature')),
        scope: 'you',
        cmp: '>=',
        n: 1,
      },
    });
    expect(
      interpretCard(pinned('Retrofitted Transmogrant')).activatedAbilities[0]?.ability.effects,
    ).toEqual([
      {
        op: 'returnSelfFromGraveyardToBattlefield',
        tapped: true,
        counter: '+1/+1',
        counterCount: 2,
      },
    ]);
  });

  it('graveyard-hand-return-negatives — non-mana costs and other conditions stay unmodeled', () => {
    for (const text of [
      'Sacrifice a Food: Return this card from your graveyard to the battlefield.',
      '{1}{B}, Sacrifice a creature: Return this card from your graveyard to the battlefield.',
      '{1}{B}: Return this card from your graveyard to the battlefield. Activate only if a non-Skeleton creature died under your control this turn.',
      '{1}{B}: Return this card from your graveyard to the battlefield attached to target creature.',
      '{1}{B}: Return this card from your graveyard to the battlefield with a finality counter on it.',
      '{1}{B}: Return target creature card from your graveyard to the battlefield tapped.',
    ])
      expect(interpretCard(lineCard(text)).modeled, text).toBe(false);
  });

  it('graveyard-hand-skeleton — activated from the graveyard, enters tapped under its owner', () => {
    const ctx = pod('graveyard-hand-skeleton');
    const skeleton = conjure(ctx, 'P1', pinned('Reassembling Skeleton'), 'graveyard');
    expect(optionFor(ctx, 'P1', skeleton.id)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), mana('BC'));
    const option = optionFor(ctx, 'P1', skeleton.id);
    expect(option?.data?.['sourceZone']).toBe('graveyard');
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(zoneOf(ctx, skeleton.cardId)).toBe('graveyard');
    settle(ctx);
    const permanent = ctx.state.battlefield.find((p) => p.cardId === skeleton.cardId);
    expect(permanent?.tapped).toBe(true);
    expect(permanent?.controllerId).toBe('P1');
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  });

  it('graveyard-hand-skeleton-new-object — a card that left the graveyard in response is not returned', () => {
    const ctx = pod('graveyard-hand-skeleton-object');
    const skeleton = conjure(ctx, 'P1', pinned('Reassembling Skeleton'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('BC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', skeleton.id)!.payload as PriorityActionPayload);
    // In response it is exiled and comes back: a new object (CR 400.7).
    const inGraveyard = playerById(ctx, 'P1').graveyard.find((c) => c.cardId === skeleton.cardId)!;
    pumpStrict(moveObject(ctx, inGraveyard, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((c) => c.cardId === skeleton.cardId) as EngineCardObject;
    pumpStrict(moveObject(ctx, exiled, { zone: 'graveyard' }));
    settle(ctx);
    expect(zoneOf(ctx, skeleton.cardId)).toBe('graveyard');
  });

  it('graveyard-hand-champion — offered only after its owner attacked this turn', () => {
    const ctx = pod('graveyard-hand-champion');
    const champion = conjure(ctx, 'P1', pinned('Bloodsoaked Champion'), 'graveyard');
    const attacker = spawn(ctx, 'P1', oracle({ name: 'Lab Attacker', power: '2', toughness: '2' }));
    addMana(playerById(ctx, 'P1'), mana('BC'));
    expect(optionFor(ctx, 'P1', champion.id)).toBeUndefined();
    pump(
      runCombatAndExtraCombats(ctx),
      (decision) => {
        if (decision.presentationAttackDeclaration !== undefined)
          return declareAttacks(decision, (id) => (id === attacker.id ? 'P2' : null));
        if (decision.presentationBlockDeclaration !== undefined) return declareNoBlocks(decision);
        const pass = decision.options.findIndex((option) => option.type === 'pass');
        return { index: Math.max(pass, 0), targets: new Map() };
      },
      { strict: true },
    );
    givePriority(ctx, 'P1', 'postcombatMain');
    ctx.state.step = null;
    addMana(playerById(ctx, 'P1'), mana('BC'));
    const option = optionFor(ctx, 'P1', champion.id);
    expect(option).toBeDefined();
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    settle(ctx);
    const permanent = ctx.state.battlefield.find((p) => p.cardId === champion.cardId);
    expect(permanent?.tapped).toBe(false);
    // An opponent's attack does not count for P1.
    const other = pod('graveyard-hand-champion-other');
    const theirs = conjure(other, 'P2', pinned('Bloodsoaked Champion'), 'graveyard');
    other.state.attackedThisTurnPlayers = { P1: true };
    givePriority(other, 'P2');
    addMana(playerById(other, 'P2'), mana('BC'));
    expect(optionFor(other, 'P2', theirs.id)).toBeUndefined();
  });

  it('graveyard-hand-haunt — needs a legendary creature', () => {
    const ctx = pod('graveyard-hand-haunt');
    const haunt = conjure(ctx, 'P1', pinned('Haunt of the Dead Marshes'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('BCC'));
    spawn(ctx, 'P1', oracle({ name: 'Lab Legend', typeLine: 'Legendary Artifact' }));
    expect(optionFor(ctx, 'P1', haunt.id)).toBeUndefined();
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Legendary Bear',
        typeLine: 'Legendary Creature — Bear',
        power: '2',
        toughness: '2',
      }),
    );
    expect(optionFor(ctx, 'P1', haunt.id)).toBeDefined();
  });

  it('graveyard-hand-control-a-condition — "Activate only if you control a …" on other cards', () => {
    // The same activation-condition form unblocks two battlefield abilities.
    expect(interpretCard(pinned("Bonders' Enclave")).activatedAbilities[0]?.condition).toEqual({
      kind: 'countPermanents',
      selector: allOf({ kind: 'powerAtLeast', n: 4 }, ofType('Creature')),
      scope: 'you',
      cmp: '>=',
      n: 1,
    });
    expect(
      interpretCard(pinned('Sliver Hive')).activatedAbilities.find((a) => a.condition)?.condition,
    ).toEqual({
      kind: 'countPermanents',
      selector: { kind: 'subtype', value: 'Sliver' },
      scope: 'you',
      cmp: '>=',
      n: 1,
    });
    const ctx = pod('graveyard-hand-enclave');
    const enclave = spawn(ctx, 'P1', pinned("Bonders' Enclave"));
    addMana(playerById(ctx, 'P1'), mana('CCC'));
    const draw = () =>
      optionsFor(ctx, 'P1', enclave.id).filter((option) => option.type === 'activateAbility');
    spawn(ctx, 'P1', oracle({ name: 'Lab Three', power: '3', toughness: '3' }));
    expect(draw()).toEqual([]);
    spawn(ctx, 'P1', oracle({ name: 'Lab Four', power: '4', toughness: '4' }));
    expect(draw()).toHaveLength(1);
  });

  it('graveyard-hand-transmogrant — enters tapped with two +1/+1 counters', () => {
    const ctx = pod('graveyard-hand-transmogrant');
    const card = conjure(ctx, 'P1', pinned('Retrofitted Transmogrant'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('BCCC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', card.id)!.payload as PriorityActionPayload);
    settle(ctx);
    const permanent = ctx.state.battlefield.find((p) => p.cardId === card.cardId);
    expect(permanent?.tapped).toBe(true);
    expect(permanent?.counters['+1/+1']).toBe(2);
  });
});

describe('embalm and eternalize', () => {
  it('graveyard-hand-embalm-ir — exile from the graveyard as a cost, sorcery speed', () => {
    const cat = interpretCard(pinned('Sacred Cat')).activatedAbilities;
    expect(cat).toEqual([
      {
        costs: [
          {
            kind: 'mana',
            cost: { generic: 0, colored: { W: 1, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
          },
          { kind: 'exileSelfFromGraveyard' },
        ],
        timing: 'sorcery',
        zone: 'graveyard',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [
            { op: 'createTokenCopyOfSourceCard', setColors: ['W'], addSubtypes: ['Zombie'] },
          ],
          description: expect.stringMatching(/^Embalm \{W\}/),
        },
      },
    ]);
    expect(
      interpretCard(pinned('Fanatic of Rhonas')).activatedAbilities.find(
        (a) => a.zone === 'graveyard',
      )?.ability.effects,
    ).toEqual([
      {
        op: 'createTokenCopyOfSourceCard',
        setColors: ['B'],
        addSubtypes: ['Zombie'],
        basePower: 4,
        baseToughness: 4,
      },
    ]);
    // Only a creature card has embalm in this shape.
    expect(interpretCard(lineCard('Embalm {W}', 'Artifact')).modeled).toBe(false);
  });

  it('graveyard-hand-embalm — a white Zombie copy with no mana cost; the card is exiled', () => {
    const ctx = pod('graveyard-hand-embalm');
    const cat = conjure(ctx, 'P1', pinned('Sacred Cat'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('W'));
    const option = optionFor(ctx, 'P1', cat.id);
    expect(option).toBeDefined();
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(zoneOf(ctx, cat.cardId)).toBe('exile');
    settle(ctx);
    const token = ctx.state.battlefield.find((p) => p.isToken && p.name === 'Sacred Cat');
    expect(token).toBeDefined();
    const chars = computeCharacteristics(ctx, token!);
    expect(chars.colors).toEqual(['W']);
    expect(chars.subtypes).toEqual(['Cat', 'Zombie']);
    expect(chars.keywords).toContain('lifelink');
    expect([chars.power, chars.toughness]).toEqual([1, 1]);
    expect(ctx.defs.get(token!.oracleId)?.manaCost).toBeNull();
  });

  it('graveyard-hand-embalm-timing — not at instant speed', () => {
    const ctx = pod('graveyard-hand-embalm-timing');
    const cat = conjure(ctx, 'P2', pinned('Sacred Cat'), 'graveyard');
    addMana(playerById(ctx, 'P2'), mana('W'));
    givePriority(ctx, 'P2');
    expect(optionFor(ctx, 'P2', cat.id)).toBeUndefined();
  });

  it('graveyard-hand-eternalize — a 4/4 black Zombie, resolving even after the card left exile', () => {
    const ctx = pod('graveyard-hand-eternalize');
    const fanatic = conjure(ctx, 'P1', pinned('Fanatic of Rhonas'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('GGCC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', fanatic.id)!.payload as PriorityActionPayload);
    // The exile was the cost; moving the exiled card away does not stop the ability.
    const exiled = ctx.state.exile.find((c) => c.cardId === fanatic.cardId) as EngineCardObject;
    pumpStrict(moveObject(ctx, exiled, { zone: 'library' }));
    settle(ctx);
    const token = ctx.state.battlefield.find((p) => p.isToken && p.name === 'Fanatic of Rhonas');
    const chars = computeCharacteristics(ctx, token!);
    expect(chars.colors).toEqual(['B']);
    expect(chars.subtypes).toEqual(['Snake', 'Druid', 'Zombie']);
    expect([chars.power, chars.toughness]).toEqual([4, 4]);
    expect(ctx.defs.get(token!.oracleId)?.manaCost).toBeNull();
  });
});

describe('shuffle into its owner’s library instead of a graveyard', () => {
  it('graveyard-hand-colossus-ir — a definition flag, no other effect', () => {
    for (const name of ['Darksteel Colossus', 'Blightsteel Colossus', 'Nexus of Fate'])
      expect(interpretCard(pinned(name)).shuffleIntoLibraryInsteadOfGraveyard, name).toBe(true);
    for (const text of [
      "If this card would be put into a graveyard from anywhere, shuffle it into its owner's library instead.",
      "If ~ would be put into a graveyard from anywhere, reveal ~ and put it on top of its owner's library instead.",
    ])
      expect(interpretCard(lineCard(text, 'Artifact')).modeled, text).toBe(false);
  });

  it('graveyard-hand-colossus-sacrificed — a sacrificed Colossus is shuffled in and never dies', () => {
    const ctx = pod('graveyard-hand-colossus-sacrifice');
    const colossus = spawn(ctx, 'P2', pinned('Darksteel Colossus'));
    const triumph = conjure(ctx, 'P1', edict(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('BC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', triumph.id)!.payload as PriorityActionPayload);
    settle(ctx);
    expect(zoneOf(ctx, colossus.cardId)).toBe('library');
    expect(playerById(ctx, 'P2').library).toHaveLength(9);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
    const reveal = ctx.state.eventLog.find(
      (e) => e.type === 'revealCard' && e.payload['name'] === 'Darksteel Colossus',
    );
    expect(reveal).toBeDefined();
    expect(
      ctx.state.eventLog.some(
        (e) =>
          e.type === 'shuffle' && e.payload['player'] === 'P2' && e.sequence > reveal!.sequence,
      ),
    ).toBe(true);
  });

  it('graveyard-hand-colossus-discarded-milled — from the hand and from the library too', () => {
    const ctx = pod('graveyard-hand-colossus-discard');
    const inHand = conjure(ctx, 'P2', pinned('Blightsteel Colossus'), 'hand');
    const seize = conjure(ctx, 'P1', pinned('Thoughtseize'), 'hand');
    addMana(playerById(ctx, 'P1'), mana('B'));
    take(
      ctx,
      'P1',
      optionFor(ctx, 'P1', seize.id)!.payload as PriorityActionPayload,
      new Map([[0, 'P2']]),
    );
    settle(ctx, (decision) => {
      const index = decision.options.findIndex((o) => o.description.includes('Blightsteel'));
      return { index: Math.max(index, 0), targets: new Map() };
    });
    expect(zoneOf(ctx, inHand.cardId)).toBe('library');
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(0);

    const top = playerById(ctx, 'P2').library.find((c) => c.cardId === inHand.cardId)!;
    pumpStrict(moveObject(ctx, top, { zone: 'graveyard' }));
    expect(zoneOf(ctx, inHand.cardId)).toBe('library');
  });

  it('graveyard-hand-nexus — resolves into its owner’s library and still takes the extra turn', () => {
    const ctx = pod('graveyard-hand-nexus');
    const nexus = conjure(ctx, 'P1', pinned('Nexus of Fate'), 'hand');
    addMana(playerById(ctx, 'P1'), mana('UUCCCCC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', nexus.id)!.payload as PriorityActionPayload);
    settle(ctx);
    expect(zoneOf(ctx, nexus.cardId)).toBe('library');
    expect(ctx.state.extraTurns).toEqual(['P1']);
  });

  it('graveyard-hand-nexus-countered — a countered Nexus is shuffled in too', () => {
    const ctx = pod('graveyard-hand-nexus-counter');
    const nexus = conjure(ctx, 'P1', pinned('Nexus of Fate'), 'hand');
    addMana(playerById(ctx, 'P1'), mana('UUCCCCC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', nexus.id)!.payload as PriorityActionPayload);
    const counter = conjure(ctx, 'P2', pinned('Counterspell'), 'hand');
    addMana(playerById(ctx, 'P2'), mana('UU'));
    givePriority(ctx, 'P2');
    const spellId = ctx.state.stack[0]!.id;
    take(
      ctx,
      'P2',
      optionFor(ctx, 'P2', counter.id)!.payload as PriorityActionPayload,
      new Map([[0, spellId]]),
    );
    settle(ctx);
    expect(zoneOf(ctx, nexus.cardId)).toBe('library');
    expect(ctx.state.extraTurns ?? []).toEqual([]);
  });

  it('graveyard-hand-colossus-rest-in-peace — its owner chooses which replacement applies', () => {
    for (const [choice, zone] of [
      ['Shuffle', 'library'],
      ['Exile', 'exile'],
    ] as const) {
      const ctx = pod(`graveyard-hand-colossus-rip-${choice}`);
      spawn(ctx, 'P1', pinned('Rest in Peace'));
      const inHand = conjure(ctx, 'P2', pinned('Darksteel Colossus'), 'hand');
      const seize = conjure(ctx, 'P1', pinned('Thoughtseize'), 'hand');
      addMana(playerById(ctx, 'P1'), mana('B'));
      take(
        ctx,
        'P1',
        optionFor(ctx, 'P1', seize.id)!.payload as PriorityActionPayload,
        new Map([[0, 'P2']]),
      );
      const prompts: { player: string; prompt: string }[] = [];
      settle(ctx, (decision) => {
        if (decision.prompt.includes('Choose which replacement')) {
          prompts.push({ player: decision.player, prompt: decision.prompt });
          const index = decision.options.findIndex((o) => o.description.startsWith(choice));
          return { index, targets: new Map() };
        }
        const index = decision.options.findIndex((o) => o.description.includes('Darksteel'));
        return { index: Math.max(index, 0), targets: new Map() };
      });
      expect(prompts.map((p) => p.player)).toEqual(['P2']);
      expect(zoneOf(ctx, inHand.cardId), choice).toBe(zone);
    }
  });

  it('graveyard-hand-colossus-humility — an ability-less permanent goes to the graveyard', () => {
    const ctx = pod('graveyard-hand-colossus-humility');
    const colossus = spawn(ctx, 'P2', pinned('Darksteel Colossus'));
    // A Humility-style static: creatures lose all abilities (layer 6).
    const humility = oracle({ name: 'Lab Humility', typeLine: 'Enchantment' });
    registerCustomDef(ctx, {
      ...structuredClone(interpretCard(humility)),
      staticEffects: [{ affects: ofType('Creature'), op: { layer: 6, loseAllAbilities: true } }],
    });
    spawn(ctx, 'P1', humility);
    const triumph = conjure(ctx, 'P1', edict(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('BC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', triumph.id)!.payload as PriorityActionPayload);
    settle(ctx);
    expect(zoneOf(ctx, colossus.cardId)).toBe('graveyard');
  });
});

describe('mana abilities from the hand (Spirit Guides)', () => {
  const mountain = () =>
    oracle({ name: 'Mountain', typeLine: 'Basic Land — Mountain', oracleText: '({T}: Add {R}.)' });
  const shock = (manaCost: string, name = 'Lab Shock') =>
    oracle({
      name,
      typeLine: 'Instant',
      manaCost,
      colors: ['R'],
      oracleText: `${name} deals 2 damage to any target.`,
    });

  it('graveyard-hand-spirit-guide-ir — a hand mana ability, nothing on the battlefield', () => {
    const def = interpretCard(pinned('Simian Spirit Guide'));
    expect(def.handManaAbility).toEqual({ units: [['R']] });
    expect(def.manaAbilities).toEqual([]);
    expect(def.activatedAbilities).toEqual([]);
    expect(interpretCard(pinned('Elvish Spirit Guide')).handManaAbility).toEqual({
      units: [['G']],
    });
    for (const text of [
      'Exile this card from your hand: Add {R}{R}.',
      'Exile this card from your graveyard: Add {R}.',
    ])
      expect(interpretCard(lineCard(text)).modeled, text).toBe(false);
  });

  it('graveyard-hand-spirit-guide-spare — never exiled when the board pays alone', () => {
    const ctx = pod('graveyard-hand-guide-spare');
    spawn(ctx, 'P1', mountain());
    const guide = conjure(ctx, 'P1', pinned('Simian Spirit Guide'), 'hand');
    const spell = conjure(ctx, 'P1', shock('{R}'), 'hand');
    take(
      ctx,
      'P1',
      optionFor(ctx, 'P1', spell.id)!.payload as PriorityActionPayload,
      new Map([[0, 'P2']]),
    );
    expect(zoneOf(ctx, guide.cardId)).toBe('hand');
    expect(ctx.state.battlefield.find((p) => p.name === 'Mountain')?.tapped).toBe(true);
  });

  it('graveyard-hand-spirit-guide-needed — offered and spent when the payment needs it', () => {
    const ctx = pod('graveyard-hand-guide-needed');
    spawn(ctx, 'P1', mountain());
    const spell = conjure(ctx, 'P1', shock('{1}{R}{R}', 'Lab Blast'), 'hand');
    expect(optionFor(ctx, 'P1', spell.id)).toBeUndefined();
    const first = conjure(ctx, 'P1', pinned('Simian Spirit Guide'), 'hand');
    expect(optionFor(ctx, 'P1', spell.id)).toBeUndefined();
    const second = conjure(ctx, 'P1', pinned('Simian Spirit Guide'), 'hand');
    const third = conjure(ctx, 'P1', pinned('Elvish Spirit Guide'), 'hand');
    const option = optionFor(ctx, 'P1', spell.id);
    expect(option).toBeDefined();
    take(ctx, 'P1', option!.payload as PriorityActionPayload, new Map([[0, 'P2']]));
    // Two cards are needed with the Mountain, and only two are exiled.
    const exiled = [first, second, third].filter((c) => zoneOf(ctx, c.cardId) === 'exile');
    expect(exiled).toHaveLength(2);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.stack.map((entry) => entry.card?.name)).toEqual(['Lab Blast']);
    expect(
      ctx.state.eventLog.filter((e) => e.type === 'manaAbilityActivated').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('graveyard-hand-spirit-guide-ability — pays for an activated ability too', () => {
    const ctx = pod('graveyard-hand-guide-ability');
    const skeleton = conjure(ctx, 'P1', pinned('Reassembling Skeleton'), 'graveyard');
    addMana(playerById(ctx, 'P1'), mana('B'));
    expect(optionFor(ctx, 'P1', skeleton.id)).toBeUndefined();
    const guide = conjure(ctx, 'P1', pinned('Elvish Spirit Guide'), 'hand');
    const option = optionFor(ctx, 'P1', skeleton.id);
    expect(option).toBeDefined();
    take(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(zoneOf(ctx, guide.cardId)).toBe('exile');
    settle(ctx);
    expect(zoneOf(ctx, skeleton.cardId)).toBe('battlefield');
  });

  it('graveyard-hand-spirit-guide-self — a Spirit Guide never pays to cast itself', () => {
    const ctx = pod('graveyard-hand-guide-self');
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', mountain());
    const guide = conjure(ctx, 'P1', pinned('Simian Spirit Guide'), 'hand');
    // {2}{R} with two Mountains: the card itself cannot be the third mana.
    expect(optionsFor(ctx, 'P1', guide.id).filter((option) => option.type === 'castSpell')).toEqual(
      [],
    );
  });
});
