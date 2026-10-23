import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from '../src/cards/definition';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlGraveyardOverrides } from '../src/cards/overrides/white-black-control-graveyard';
import { computeCharacteristics } from '../src/effects/continuous';
import { discardCard, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../src/state/types';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { movePermanentsTogether } from '../src/state/objects';
import { copies, conjure, gameConfig, oracle, plains, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Rest in Peace': '9519ed723522e91ca26f35969166d20f2c1e764dc274282a377c52851a63d2a4',
  'Stone of Erech': 'e15fa33bcd6283f55ec175f1ea4d8b2bb245aea1eecebaafd8cabe51bded8f84',
} as const;

const cards = new Map<keyof typeof pins, PinnedCard>();
for (const [name, sha256] of Object.entries(pins) as [keyof typeof pins, string][]) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  if (entry.sha256 !== sha256) throw new Error(`Oracle hash drift for ${name}`);
  cards.set(name, entry);
}

beforeAll(() => registerWhiteBlackControlGraveyardOverrides());

function card(name: keyof typeof pins): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card ${name}`);
  return entry.card;
}

function context(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function player(ctx: GameContext, playerId: string): EnginePlayerState {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

function cardNamed(name: string, typeLine: string, manaCost: string | null = '{1}'): OracleCard {
  return oracle({
    name,
    typeLine,
    manaCost,
    cmc: 1,
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
  });
}

function castPinned(ctx: GameContext, name: keyof typeof pins): EnginePermanent | undefined {
  const playerId = 'P1';
  spawn(ctx, playerId, plains());
  for (let index = 0; index < 3; index++) spawn(ctx, playerId, swamp());
  conjure(ctx, playerId, card(name), 'hand');
  // Importing the normal priority flow statically keeps this helper identical to card suites.
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    const pass = decision.options.findIndex((option) => /Pass|does not/i.test(option.description));
    return { index: pass >= 0 ? pass : 0, targets: new Map() };
  });
  expect(cast, `cast ${name} through priority`).toBe(true);
  return ctx.state.battlefield.find((permanent) => permanent.name === name);
}

function moveToGraveyard(
  ctx: GameContext,
  object: EnginePermanent | ReturnType<typeof conjure>,
): void {
  pump(moveObject(ctx, object, { zone: 'graveyard' }));
}

describe('white-black-control graveyard cards — pinned Oracle', () => {
  it('pins Oracle hashes and fully models both cards under the local overrides', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(cards.get(name)?.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, name).toBe(true);
      expect(definition.unmodeledReasons, name).toEqual([]);
    }
  });

  it('rest-in-peace-c01-positive — normal cast resolves its enters trigger and exiles every graveyard', () => {
    const ctx = context('rest-in-peace-etb');
    conjure(ctx, 'P1', swamp(), 'graveyard');
    conjure(ctx, 'P2', swamp(), 'graveyard');
    castPinned(ctx, 'Rest in Peace');
    expect(player(ctx, 'P1').graveyard).toEqual([]);
    expect(player(ctx, 'P2').graveyard).toEqual([]);
    expect(ctx.state.exile.map((object) => object.name)).toEqual(expect.arrayContaining(['Swamp']));
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('rest-in-peace-c02-positive — replaces hand discard, mill, spell resolution, and battlefield deaths', () => {
    const ctx = context('rest-in-peace-moves');
    castPinned(ctx, 'Rest in Peace');
    const hand = conjure(ctx, 'P2', cardNamed('Discarded Under Peace', 'Sorcery'), 'hand');
    const milled = conjure(ctx, 'P2', cardNamed('Milled Under Peace', 'Sorcery'), 'library');
    pump(discardCard(ctx, hand, 'P2'));
    pump(moveObject(ctx, milled, { zone: 'graveyard' }));
    const resolving = conjure(ctx, 'P3', cardNamed('Resolved Under Peace', 'Sorcery'), 'hand');
    pump(moveObject(ctx, resolving, { zone: 'stack' }));
    pump(moveObject(ctx, resolving, { zone: 'graveyard' }));
    const creature = spawn(ctx, 'P4', cardNamed('Doomed Under Peace', 'Creature — Bear'));
    moveToGraveyard(ctx, creature);
    expect(player(ctx, 'P2').graveyard).toEqual([]);
    expect(player(ctx, 'P3').graveyard).toEqual([]);
    expect(player(ctx, 'P4').graveyard).toEqual([]);
    expect(ctx.state.exile.map((object) => object.name)).toEqual(
      expect.arrayContaining([
        'Discarded Under Peace',
        'Milled Under Peace',
        'Resolved Under Peace',
        'Doomed Under Peace',
      ]),
    );
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(1);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
  });

  it('rest-in-peace-c03-positive/c04-negative — tokens cease, and simultaneous departure does not turn off replacement early', () => {
    const ctx = context('rest-in-peace-simultaneous');
    const peace = castPinned(ctx, 'Rest in Peace');
    expect(peace).toBeDefined();
    const token = spawn(ctx, 'P2', cardNamed('Peace Token', 'Creature — Spirit'), {
      isToken: true,
    });
    const ordinary = spawn(ctx, 'P3', cardNamed('Other Creature', 'Creature — Bear'));
    pump(moveObject(ctx, token, { zone: 'graveyard' }));
    expect(ctx.state.exile.some((object) => object.name === 'Peace Token')).toBe(false);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
    const peaceCard = player(ctx, 'P1').hand.find((object) => object.name === 'Rest in Peace');
    expect(peaceCard).toBeUndefined();
    // Move the source and a creature in one batch, so both replacements see the pre-event battlefield.
    pump(movePermanentsTogether(ctx, [peace!, ordinary], { zone: 'graveyard' }));
    expect(ctx.state.battlefield.some((permanent) => permanent.id === peace!.id)).toBe(false);
    expect(player(ctx, 'P1').graveyard).toEqual([]);
    expect(player(ctx, 'P3').graveyard).toEqual([]);
    expect(ctx.state.exile.map((object) => object.name)).toEqual(
      expect.arrayContaining(['Rest in Peace', 'Other Creature']),
    );
    expect(ctx.state.exile.some((object) => object.id === token.id)).toBe(false);
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
    const after = spawn(ctx, 'P2', cardNamed('After Peace Creature', 'Creature — Bear'));
    moveToGraveyard(ctx, after);
    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toContain(
      'After Peace Creature',
    );
  });

  it('stone-of-erech-c01-positive/c02-negative — applies to opponent-controlled current creatures only', () => {
    const ctx = context('stone-death-replacement');
    const stone = castPinned(ctx, 'Stone of Erech');
    expect(stone).toBeDefined();
    const opponentCreature = spawn(ctx, 'P2', cardNamed('Opponent Creature', 'Creature — Bear'));
    moveToGraveyard(ctx, opponentCreature);
    expect(player(ctx, 'P2').graveyard).toEqual([]);
    expect(ctx.state.exile.some((object) => object.name === 'Opponent Creature')).toBe(true);
    const ownCreature = spawn(ctx, 'P1', cardNamed('Own Creature', 'Creature — Bear'));
    moveToGraveyard(ctx, ownCreature);
    expect(player(ctx, 'P1').graveyard.some((object) => object.name === 'Own Creature')).toBe(true);
    expect(ctx.state.creaturesDiedThisTurn).toBe(1);
    const noncreature = spawn(ctx, 'P2', cardNamed('Opponent Artifact', 'Artifact'));
    moveToGraveyard(ctx, noncreature);
    expect(player(ctx, 'P2').graveyard.some((object) => object.name === 'Opponent Artifact')).toBe(
      true,
    );
    const hand = conjure(ctx, 'P2', cardNamed('Opponent Discard', 'Sorcery'), 'hand');
    pump(discardCard(ctx, hand, 'P2'));
    expect(player(ctx, 'P2').graveyard.some((object) => object.name === 'Opponent Discard')).toBe(
      true,
    );
    const milled = conjure(ctx, 'P2', cardNamed('Opponent Mill', 'Sorcery'), 'library');
    pump(moveObject(ctx, milled, { zone: 'graveyard' }));
    expect(player(ctx, 'P2').graveyard.some((object) => object.name === 'Opponent Mill')).toBe(
      true,
    );
    const animated = spawn(ctx, 'P2', cardNamed('Animated Artifact', 'Artifact'));
    ctx.defs.set('oracle-animated-artifact', {
      ...interpretCard(cardNamed('Animated Artifact', 'Artifact')),
      staticEffects: [{ affects: { kind: 'self' }, op: { layer: 4, addTypes: ['Creature'] } }],
    });
    expect(computeCharacteristics(ctx, animated).types).toContain('Creature');
    moveToGraveyard(ctx, animated);
    expect(player(ctx, 'P2').graveyard.some((object) => object.id === animated.id)).toBe(false);
    expect(ctx.state.exile.some((object) => object.name === 'Animated Artifact')).toBe(true);
    const token = spawn(ctx, 'P2', cardNamed('Opponent Token Creature', 'Creature — Spirit'), {
      isToken: true,
    });
    const deathsBeforeToken = ctx.state.creaturesDiedThisTurn;
    moveToGraveyard(ctx, token);
    expect(ctx.state.creaturesDiedThisTurn).toBe(deathsBeforeToken);
    expect(player(ctx, 'P2').graveyard).not.toContainEqual(
      expect.objectContaining({ id: token.id }),
    );
  });

  it('rest-in-peace-c05-negative — losing abilities or leaving the battlefield ends replacement coverage', () => {
    const ctx = context('rest-in-peace-lost-abilities');
    const peace = castPinned(ctx, 'Rest in Peace');
    if (peace === undefined) throw new Error('Rest in Peace did not enter');
    const definition = ctx.defs.get(peace.oracleId);
    if (definition === undefined) throw new Error('Rest in Peace definition is absent');
    definition.staticEffects.push({
      affects: { kind: 'self' },
      op: { layer: 6, loseAllAbilities: true },
    });
    const whileBlanked = spawn(ctx, 'P2', cardNamed('Creature While Blank', 'Creature — Bear'));
    moveToGraveyard(ctx, whileBlanked);
    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toContain(
      'Creature While Blank',
    );
  });

  it('stone-of-erech-c06-positive — its death replacement sees its own simultaneous departure', () => {
    const ctx = context('stone-simultaneous-departure');
    const stone = castPinned(ctx, 'Stone of Erech');
    if (stone === undefined) throw new Error('Stone of Erech did not enter');
    const creature = spawn(
      ctx,
      'P2',
      cardNamed('Simultaneous Opponent Creature', 'Creature — Bear'),
    );
    pump(movePermanentsTogether(ctx, [stone, creature], { zone: 'graveyard' }));
    expect(ctx.state.exile.some((object) => object.name === 'Simultaneous Opponent Creature')).toBe(
      true,
    );
    expect(player(ctx, 'P2').graveyard).toEqual([]);
    expect(player(ctx, 'P1').graveyard.map((object) => object.name)).toContain('Stone of Erech');
    expect(ctx.state.creaturesDiedThisTurn).toBe(0);
  });

  it('stone-of-erech-c03-positive/c04-negative — paid activation exiles any player graveyard, then draws', () => {
    const ctx = context('stone-paid-activation');
    const stone = castPinned(ctx, 'Stone of Erech');
    if (stone === undefined) throw new Error('Stone of Erech did not enter');
    conjure(ctx, 'P2', cardNamed('Target Graveyard One', 'Sorcery'), 'graveyard');
    conjure(ctx, 'P2', cardNamed('Target Graveyard Two', 'Sorcery'), 'graveyard');
    player(ctx, 'P1').library = [];
    conjure(ctx, 'P1', cardNamed('Target Top Card', 'Sorcery'), 'library');
    for (const _ of [0, 1]) spawn(ctx, 'P1', swamp());
    const p1 = player(ctx, 'P1');
    const option = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === stone.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P2']]),
      }),
    );
    expect(stone.tapped).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === stone.id)).toBe(false);
    expect(ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(ctx));
    expect(player(ctx, 'P2').graveyard).toEqual([]);
    expect(ctx.state.exile.map((object) => object.name)).toEqual(
      expect.arrayContaining(['Target Graveyard One', 'Target Graveyard Two']),
    );
    expect(player(ctx, 'P1').hand.map((object) => object.name)).toContain('Target Top Card');
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('stone-of-erech-c05-positive — self is a legal target, including when its graveyard is empty', () => {
    const ctx = context('stone-self-empty-activation');
    const stone = castPinned(ctx, 'Stone of Erech');
    if (stone === undefined) throw new Error('Stone of Erech did not enter');
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', swamp());
    conjure(ctx, 'P1', cardNamed('Draw Regardless', 'Sorcery'), 'library');
    const p1 = player(ctx, 'P1');
    const option = computePriorityOptions(ctx, p1).find((entry) => {
      const payload = entry.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === stone.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, 'P1']]),
      }),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.id === stone.id)).toBe(false);
    pump(resolveTopOfStack(ctx));
    expect(player(ctx, 'P1').hand.map((object) => object.name)).toContain('Draw Regardless');
  });

  it('rejects malformed graveyard replacement scope, basis, token rule, and creature restriction', () => {
    const definition = interpretCard(card('Stone of Erech'));
    const variants: Partial<NonNullable<CardDefinition['ruleStatics'][number]>>[] = [
      { scope: 'self' } as never,
      { basis: 'source' } as never,
      { includeTokens: undefined } as never,
      { creatureFromBattlefieldOnly: false } as never,
    ];
    for (const patch of variants) {
      const malformed = {
        ...definition,
        ruleStatics: definition.ruleStatics.map((rule) => ({ ...rule, ...patch })),
      };
      expect(validateCardDefinition(malformed as CardDefinition).length).toBeGreaterThan(0);
    }
  });
});
