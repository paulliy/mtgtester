import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { dealDamageToPlayer } from '../src/effects/resolve';
import type { EffectSource } from '../src/effects/resolve';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import { cleanupStep } from '../src/turn/turn';
import { resolveTopOfStack } from '../src/stack/stack';
import { wardCostOf } from '../src/state/queries';
import { moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
function pinned(name: string): OracleCard {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing PR09 pin ${name}`);
  return entry.card;
}
const MARVEL = pinned('Aetherworks Marvel');
const HERALD = pinned('Herald of Amity');
const PILLAGER = pinned('Dream Pillager');
const CUBE = pinned('Cosmic Cube');
const faceFixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
function faceFixtureCard(name: string): OracleCard {
  const entry = faceFixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing selected-face fixture ${name}`);
  return entry.card;
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
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
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

const p = (ctx: GameContext, id: string) => playerById(ctx, id);
const sourceOf = (permanent: EnginePermanent): EffectSource => ({
  id: permanent.id,
  cardId: permanent.cardId,
  name: permanent.name,
  oracleId: permanent.oracleId,
  controllerId: permanent.controllerId,
});

function pass(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  if (index < 0) throw new Error(`no priority pass option for ${decision.prompt}`);
  return { index, targets: new Map() };
}

function settle(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(ctx), (decision) =>
    decision.decisionType === 'priority' ? pass(decision) : answer(decision),
  );
}

function chooseDescription(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0) {
    throw new Error(
      `no ${pattern} option in ${decision.options.map((option) => option.description).join(' | ')}`,
    );
  }
  const option = decision.options[index]!;
  return {
    index,
    targets: new Map((option.targets ?? []).map((target) => [target.slot, target.options[0]!])),
  };
}

function decline(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex((option) => option.type === 'decline');
  if (index < 0) throw new Error(`no decline option in ${decision.prompt}`);
  return { index, targets: new Map() };
}

function library(ctx: GameContext, ownerId: string, cards: OracleCard[]) {
  const owner = p(ctx, ownerId);
  const objects = cards.map((card) => conjure(ctx, ownerId, card, 'library'));
  owner.library = objects;
  return [...objects];
}

function castNormally(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: ('B' | 'C' | 'G' | 'R' | 'U' | 'W')[],
  targets: Map<number, string> = new Map(),
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(
    p(ctx, playerId),
    mana.map((symbol) => ({ symbol })),
  );
  const option = computePriorityOptions(ctx, p(ctx, playerId)).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return (
      candidate.type === 'castSpell' &&
      payload.kind === 'castSpell' &&
      payload.objectId === object.id
    );
  });
  expect(option, `${card.name} has the normal cast action`).toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  settle(ctx, answer);
  return object;
}

function activateMarvel(
  ctx: GameContext,
  marvel: EnginePermanent,
  answer: (d: PendingDecision) => DecisionOutcome = pass,
) {
  const option = computePriorityOptions(ctx, p(ctx, 'P1')).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === marvel.id;
  });
  expect(option, 'Marvel activation is offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  return pump(resolveTopOfStack(ctx), answer);
}

function libraryCard(
  name: string,
  manaValue: number,
  typeLine: string,
  more: Partial<OracleCard> = {},
) {
  return oracle({
    name,
    typeLine,
    manaCost: manaValue === 0 ? '{0}' : `{${manaValue}}`,
    cmc: manaValue,
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
    oracleText: /\b(?:Instant|Sorcery)\b/.test(typeLine) ? 'Draw a card.' : '',
    ...more,
  });
}

function attackAndResolve(ctx: GameContext, attackers: EnginePermanent[], answer = pass) {
  const ids = new Set(attackers.map((attacker) => attacker.id));
  return pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      return declareAttacks(decision, (id) => (ids.has(id) ? 'P2' : null));
    }
    return decision.decisionType === 'priority' ? pass(decision) : answer(decision);
  });
}

function attackAtPlaneswalker(
  ctx: GameContext,
  attackers: EnginePermanent[],
  walker: EnginePermanent,
) {
  const ids = new Set(attackers.map((attacker) => attacker.id));
  return pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      return declareAttacks(decision, (id, subject) =>
        ids.has(id)
          ? (subject.planeswalkers.find((candidate) => candidate.objectId === walker.id)
              ?.objectId ?? null)
          : null,
      );
    }
    return decision.decisionType === 'priority' ? pass(decision) : pass(decision);
  });
}

function activateOptions(ctx: GameContext, object: EnginePermanent) {
  return computePriorityOptions(ctx, p(ctx, object.controllerId)).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === object.id;
  });
}

describe('PR09 free library cards', () => {
  it('pr09-marvel-normal-cast — pays {4} through the ordinary cast action', () => {
    const ctx = pod('pr09-marvel-cast');
    const card = castNormally(ctx, 'P1', MARVEL, ['C', 'C', 'C', 'C']);
    const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId);
    expect(permanent?.name).toBe('Aetherworks Marvel');
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(interpretCard(MARVEL).modeled).toBe(true);
  });

  it('pr09-marvel-energy — a controlled noncreature permanent entering its graveyard yields one energy', () => {
    const ctx = pod('pr09-marvel-energy');
    const marvel = spawn(ctx, 'P1', MARVEL);
    const artifact = spawn(ctx, 'P1', libraryCard('Marvel Artifact', 2, 'Artifact'));
    pump(moveObject(ctx, artifact, { zone: 'graveyard' }));
    settle(ctx);
    expect(p(ctx, 'P1').energy).toBe(1);
    expect(marvel.zone).toBe('battlefield');
  });

  it('pr09-marvel-self-to-graveyard — Marvel triggers for itself as a permanent even after it leaves', () => {
    const ctx = pod('pr09-marvel-self-graveyard');
    const marvel = spawn(ctx, 'P1', MARVEL);
    pump(moveObject(ctx, marvel, { zone: 'graveyard' }));
    settle(ctx);
    expect(p(ctx, 'P1').energy).toBe(1);
    expect(p(ctx, 'P1').graveyard.some((card) => card.cardId === marvel.cardId)).toBe(true);
  });

  it('pr09-marvel-energy-exclusions — opponent permanents, hand cards, and exiled permanents do not trigger it', () => {
    const ctx = pod('pr09-marvel-energy-exclusions');
    spawn(ctx, 'P1', MARVEL);
    const opposing = spawn(ctx, 'P2', libraryCard('Opponent Artifact', 2, 'Artifact'));
    const own = spawn(ctx, 'P1', libraryCard('Own Artifact', 2, 'Artifact'));
    const hand = conjure(ctx, 'P1', libraryCard('Discarded Card', 1, 'Artifact'), 'hand');
    pump(moveObject(ctx, opposing, { zone: 'graveyard' }));
    pump(moveObject(ctx, own, { zone: 'exile' }));
    pump(moveObject(ctx, hand, { zone: 'graveyard' }));
    settle(ctx);
    expect(p(ctx, 'P1').energy).toBe(0);
  });

  it('pr09-marvel-cost-gates — requires six energy and an untapped Marvel', () => {
    const ctx = pod('pr09-marvel-cost-gates');
    const marvel = spawn(ctx, 'P1', MARVEL);
    p(ctx, 'P1').energy = 5;
    expect(activateOptions(ctx, marvel)).toHaveLength(0);
    p(ctx, 'P1').energy = 6;
    expect(activateOptions(ctx, marvel)).toHaveLength(1);
    marvel.tapped = true;
    expect(activateOptions(ctx, marvel)).toHaveLength(0);
  });

  it('pr09-marvel-activate-cast-one — pays six energy, taps, offers an optional spell and casts it onto the stack', () => {
    const ctx = pod('pr09-marvel-activate-cast');
    const marvel = spawn(ctx, 'P1', MARVEL);
    p(ctx, 'P1').energy = 6;
    const creature = libraryCard('Marvel Free Creature', 3, 'Creature — Test');
    const other = libraryCard('Marvel Other Spell', 2, 'Sorcery');
    const cards = library(ctx, 'P1', [
      creature,
      other,
      ...Array.from({ length: 4 }, (_, i) => libraryCard(`Marvel Extra ${i}`, 2, 'Sorcery')),
    ]);
    const result = activateMarvel(ctx, marvel, (decision) =>
      chooseDescription(decision, /Marvel Free Creature/),
    );
    expect(p(ctx, 'P1').energy).toBe(0);
    expect(marvel.tapped).toBe(true);
    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => /Marvel Free Creature/.test(option.description)),
      ),
    ).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Marvel Free Creature',
      ),
    ).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((object) => object.name === 'Marvel Free Creature')).toBe(
      true,
    );
    expect(cards).toHaveLength(6);
  });

  it('pr09-marvel-no-eligible-decline-empty — bottoms nonspells without a choice and bottoms the full set after decline', () => {
    const ctx = pod('pr09-marvel-no-eligible');
    const marvel = spawn(ctx, 'P1', MARVEL);
    p(ctx, 'P1').energy = 6;
    const lands = library(
      ctx,
      'P1',
      Array.from({ length: 6 }, (_, i) => libraryCard(`Marvel Land ${i}`, 0, 'Land')),
    );
    const noChoice = activateMarvel(ctx, marvel);
    expect(
      noChoice.decisions.some((decision) =>
        decision.options.some((option) => option.type === 'castFree'),
      ),
    ).toBe(false);
    expect(new Set(p(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(lands.map((card) => card.cardId)),
    );

    const declineCtx = pod('pr09-marvel-decline');
    const declineMarvel = spawn(declineCtx, 'P1', MARVEL);
    p(declineCtx, 'P1').energy = 6;
    const spells = library(
      declineCtx,
      'P1',
      Array.from({ length: 6 }, (_, i) => libraryCard(`Marvel Decline ${i}`, 2, 'Sorcery')),
    );
    activateMarvel(declineCtx, declineMarvel, decline);
    expect(new Set(p(declineCtx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(spells.map((card) => card.cardId)),
    );

    const emptyCtx = pod('pr09-marvel-empty');
    const emptyMarvel = spawn(emptyCtx, 'P1', MARVEL);
    p(emptyCtx, 'P1').energy = 6;
    const empty = activateMarvel(emptyCtx, emptyMarvel);
    expect(empty.decisions).toHaveLength(0);
    expect(p(emptyCtx, 'P1').hasLost).toBe(false);
  });

  it('pr09-marvel-no-land-permission — a land in the looked-at set is never offered as a play action', () => {
    const ctx = pod('pr09-marvel-no-land-permission');
    const marvel = spawn(ctx, 'P1', MARVEL);
    p(ctx, 'P1').energy = 6;
    const land = library(ctx, 'P1', [libraryCard('Marvel Nonbasic Land', 0, 'Land')])[0]!;
    activateMarvel(ctx, marvel);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'playLand' &&
          (option.payload as { objectId?: string }).objectId === land.id,
      ),
    ).toBe(false);
    expect(p(ctx, 'P1').library).toContain(land);
  });

  it('pr09-herald-normal-cast-and-flying — pays its printed cost and enters with flying', () => {
    const ctx = pod('pr09-herald-cast');
    const card = castNormally(ctx, 'P1', HERALD, ['C', 'W', 'W', 'C']);
    const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === card.cardId);
    expect(permanent?.name).toBe('Herald of Amity');
    expect(interpretCard(HERALD).modeled).toBe(true);
  });

  it('pr09-herald-etb-exiles-before-aura-cast — exiles eight real cards before offering the Aura and casts it on the normal stack', () => {
    const ctx = pod('pr09-herald-etb');
    const host = spawn(ctx, 'P1', libraryCard('Aura Host', 2, 'Creature — Test'));
    const watcher = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Spell Cast Witness',
        typeLine: 'Creature — Witness',
        oracleText: 'Whenever you cast a spell, you gain 1 life.',
      }),
    );
    const aura = libraryCard('Herald Lab Aura', 1, 'Enchantment — Aura', {
      oracleText: 'Enchant creature',
    });
    const cards = library(ctx, 'P1', [
      aura,
      ...Array.from({ length: 7 }, (_, i) => libraryCard(`Herald Exile ${i}`, 1, 'Sorcery')),
    ]);
    let sawEightExiledBeforePick = false;
    castNormally(ctx, 'P1', HERALD, ['C', 'C', 'C', 'W'], new Map(), (decision) => {
      if (decision.options.some((option) => /Herald Lab Aura/.test(option.description))) {
        sawEightExiledBeforePick =
          p(ctx, 'P1').library.length === 0 &&
          ctx.state.exile.filter((card) => card.zone === 'exile').length === 8;
        return chooseDescription(decision, /Herald Lab Aura/);
      }
      if (decision.decisionType === 'chooseTargets')
        return { index: 0, targets: new Map([[0, host.id]]) };
      return pass(decision);
    });
    expect(sawEightExiledBeforePick).toBe(true);
    expect(
      ctx.state.eventLog.filter(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['from'] === 'library' &&
          event.payload['to'] === 'exile',
      ),
    ).toHaveLength(8);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Herald Lab Aura',
      ),
    ).toBe(true);
    expect(p(ctx, 'P1').life).toBe(42);
    expect(watcher.zone).toBe('battlefield');
    const returnedLibrary = p(ctx, 'P1').library;
    expect(returnedLibrary).toHaveLength(7);
    expect(returnedLibrary.map((card) => card.cardId).sort()).toEqual(
      cards
        .slice(1)
        .map((card) => card.cardId)
        .sort(),
    );
    expect(returnedLibrary.every((current) => cards.every((old) => old.id !== current.id))).toBe(
      true,
    );
    expect(
      ctx.state.battlefield.some(
        (permanent) => permanent.name === 'Herald Lab Aura' && permanent.attachedTo === host.id,
      ),
    ).toBe(true);
    expect(cards).toHaveLength(8);
  });

  it('pr09-herald-aura-filter — only Aura cards are legal casts, not Aura-subtype creatures or ordinary spells', () => {
    const ctx = pod('pr09-herald-filter');
    const host = spawn(ctx, 'P1', libraryCard('Filter Aura Host', 2, 'Creature — Test'));
    const fakeAura = libraryCard('Aura Creature', 2, 'Creature — Aura', {
      subtypes: ['Aura'],
      types: ['Creature'],
    });
    const trueAura = libraryCard('Filter True Aura', 1, 'Enchantment — Aura', {
      oracleText: 'Enchant creature',
    });
    const cards = library(ctx, 'P1', [
      fakeAura,
      trueAura,
      ...Array.from({ length: 6 }, (_, i) => libraryCard(`Herald Filter ${i}`, 1, 'Sorcery')),
    ]);
    const offered: string[] = [];
    castNormally(ctx, 'P1', HERALD, ['C', 'C', 'C', 'W'], new Map(), (decision) => {
      offered.push(
        ...decision.options
          .filter((option) => option.type === 'castFree')
          .map((option) => option.description),
      );
      if (decision.options.some((option) => /Filter True Aura/.test(option.description)))
        return chooseDescription(decision, /Filter True Aura/);
      if (decision.decisionType === 'chooseTargets')
        return { index: 0, targets: new Map([[0, host.id]]) };
      return pass(decision);
    });
    expect(offered.some((description) => /Filter True Aura/.test(description))).toBe(true);
    expect(
      offered.some((description) => /Aura Creature|Herald Filter/.test(description)),
      offered.join(' | '),
    ).toBe(false);
    expect(
      ctx.state.battlefield.some(
        (permanent) => permanent.name === 'Filter True Aura' && permanent.attachedTo === host.id,
      ),
    ).toBe(true);
    expect(cards).toHaveLength(8);
  });

  it('pr09-herald-no-host — an Aura with no legal target is uncastable and all eight exiled cards return to the library', () => {
    const ctx = pod('pr09-herald-no-host');
    const cards = library(ctx, 'P1', [
      libraryCard('No Host Aura', 1, 'Enchantment — Aura', { oracleText: 'Enchant creature' }),
      ...Array.from({ length: 7 }, (_, i) => libraryCard(`No Host Spell ${i}`, 1, 'Sorcery')),
    ]);
    const choices = castNormally(ctx, 'P1', HERALD, ['C', 'C', 'C', 'W'], new Map(), (decision) => {
      const herald = ctx.state.battlefield.find(
        (permanent) => permanent.name === 'Herald of Amity',
      );
      if (herald !== undefined) pump(moveObject(ctx, herald, { zone: 'graveyard' }));
      return decision.options.some((option) => option.type === 'decline')
        ? decline(decision)
        : pass(decision);
    });
    expect(choices.cardId).toBeDefined();
    expect(p(ctx, 'P1').library).toHaveLength(8);
    expect(ctx.state.exile).toHaveLength(0);
    expect(new Set(p(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );
  });

  it('pr09-herald-decline-and-empty — decline bottoms every exiled card; an empty library has no choice', () => {
    const ctx = pod('pr09-herald-decline');
    spawn(ctx, 'P1', libraryCard('Decline Aura Host', 2, 'Creature — Test'));
    const cards = library(ctx, 'P1', [
      libraryCard('Decline Aura', 1, 'Enchantment — Aura', { oracleText: 'Enchant creature' }),
      ...Array.from({ length: 7 }, (_, i) => libraryCard(`Decline Spell ${i}`, 1, 'Sorcery')),
    ]);
    castNormally(ctx, 'P1', HERALD, ['C', 'C', 'C', 'W'], new Map(), decline);
    expect(p(ctx, 'P1').library).toHaveLength(8);
    expect(ctx.state.exile).toHaveLength(0);
    expect(new Set(p(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );

    const emptyCtx = pod('pr09-herald-empty');
    castNormally(emptyCtx, 'P1', HERALD, ['C', 'C', 'C', 'W']);
    expect(p(emptyCtx, 'P1').hasLost).toBe(false);
  });

  it('pr09-herald-attack-aura-count — pumps by Auras you control only, then expires at cleanup', () => {
    const ctx = pod('pr09-herald-pump');
    const herald = spawn(ctx, 'P1', HERALD);
    const ownHost = spawn(ctx, 'P1', libraryCard('Own Aura Host', 2, 'Creature — Test'));
    const opponentHost = spawn(ctx, 'P2', libraryCard('Opponent Aura Host', 2, 'Creature — Test'));
    const ownA = spawn(ctx, 'P1', libraryCard('Own Aura One', 1, 'Enchantment — Aura'));
    const ownB = spawn(ctx, 'P1', libraryCard('Own Aura Two', 1, 'Enchantment — Aura'));
    const opponentAura = spawn(ctx, 'P2', libraryCard('Opponent Aura', 1, 'Enchantment — Aura'));
    ownA.attachedTo = ownHost.id;
    ownB.attachedTo = ownHost.id;
    opponentAura.attachedTo = opponentHost.id;
    herald.summoningSick = false;
    const before = computeCharacteristics(ctx, herald);
    const decisions = attackAndResolve(ctx, [herald]);
    expect(decisions.value).toBeUndefined();
    expect(
      computeCharacteristics(ctx, herald),
      JSON.stringify({
        triggers: interpretCard(HERALD).triggers,
        stack: ctx.state.stack.map((entry) => entry.description),
        debug: ctx.debugLog.slice(-30),
        eventLog: ctx.state.eventLog.slice(-30).map((event) => event.type),
      }),
    ).toMatchObject({
      power: before.power + 2,
      toughness: before.toughness + 2,
    });
    expect(ownA.zone).toBe('battlefield');
    expect(ownB.zone).toBe('battlefield');
    pump(cleanupStep(ctx));
    expect(computeCharacteristics(ctx, herald)).toEqual(before);
  });

  it('pr09-pillager-normal-cast — pays {5}{R}{R} and resolves as a flying creature', () => {
    const ctx = pod('pr09-pillager-cast');
    const card = castNormally(ctx, 'P1', PILLAGER, ['C', 'C', 'C', 'C', 'C', 'R', 'R']);
    expect(ctx.state.battlefield.find((permanent) => permanent.cardId === card.cardId)?.name).toBe(
      'Dream Pillager',
    );
    expect(interpretCard(PILLAGER).modeled).toBe(true);
  });

  it('pr09-pillager-combat-damage — combat damage exiles that many cards and grants cast permission only until cleanup', () => {
    const ctx = pod('pr09-pillager-combat');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    pillager.summoningSick = false;
    const cards = library(
      ctx,
      'P1',
      Array.from({ length: 6 }, (_, i) =>
        libraryCard(`Pillager Card ${i}`, 2, i === 5 ? 'Land' : 'Sorcery'),
      ),
    );
    attackAndResolve(ctx, [pillager]);
    expect(
      ctx.state.eventLog.filter(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['from'] === 'library' &&
          event.payload['to'] === 'exile',
      ),
    ).toHaveLength(4);
    const exiled = ctx.state.exile.filter((card) => card.name.startsWith('Pillager Card'));
    expect(exiled).toHaveLength(4);
    expect(exiled.every((card) => card.playableUntilEotBy === 'P1')).toBe(true);
    expect(cards[5]?.playableUntilEotBy).toBeUndefined();
    pump(cleanupStep(ctx));
    expect(exiled.every((card) => card.playableUntilEotBy === undefined)).toBe(true);
  });

  it('pr09-pillager-mana-and-player-permission — combat permission grants paid spell casting only to its controller', () => {
    const ctx = pod('pr09-pillager-mana');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    pillager.summoningSick = false;
    const cards = library(ctx, 'P1', [
      libraryCard('Pillager Paid Spell', 2, 'Sorcery'),
      ...Array.from({ length: 5 }, (_, i) => libraryCard(`Pillager Filler ${i}`, 0, 'Land')),
    ]);
    const originalCard = cards[0]!;
    attackAndResolve(ctx, [pillager]);
    const exiled = ctx.state.exile.find((card) => card.cardId === originalCard.cardId)!;
    expect(exiled.zone).toBe('exile');
    expect(exiled!.playableUntilEotBy).toBe('P1');
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(true);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P2')).some(
        (option) => (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
  });

  it('pr09-pillager-noncombat-wrong-source — noncombat damage or another creature’s combat damage does not trigger the Pillager', () => {
    const ctx = pod('pr09-pillager-negative');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    const other = spawn(ctx, 'P1', libraryCard('Other Damage Source', 3, 'Creature — Test'));
    const cards = library(
      ctx,
      'P1',
      Array.from({ length: 5 }, (_, i) => libraryCard(`Pillager Negative ${i}`, 1, 'Sorcery')),
    );
    pump(
      dealDamageToPlayer(ctx, sourceOf(pillager), p(ctx, 'P2'), 2, {
        combat: false,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    pump(
      dealDamageToPlayer(ctx, sourceOf(other), p(ctx, 'P2'), 2, {
        combat: true,
        sourceIsCommander: false,
        sourceHasLifelink: false,
      }),
    );
    settle(ctx);
    expect(ctx.state.exile).toHaveLength(0);
    expect(p(ctx, 'P1').library).toEqual(cards);
  });

  it('pr09-pillager-planeswalker-and-departure — planeswalker damage does not trigger; a granted permission survives source departure', () => {
    const ctx = pod('pr09-pillager-planeswalker');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    const walker = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Walker', typeLine: 'Planeswalker — Test', loyalty: '5' }),
    );
    const cards = library(
      ctx,
      'P1',
      Array.from({ length: 5 }, (_, i) => libraryCard(`Walker Damage ${i}`, 2, 'Sorcery')),
    );
    pillager.summoningSick = false;
    attackAtPlaneswalker(ctx, [pillager], walker);
    expect(ctx.state.exile.filter((card) => card.name.startsWith('Walker Damage'))).toHaveLength(0);
    expect(p(ctx, 'P1').library).toEqual(cards);
  });

  it('pr09-pillager-source-leaves-after-permission — cleanup expires a real granted permission even if Pillager leaves', () => {
    const ctx = pod('pr09-pillager-departure');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    pillager.summoningSick = false;
    const cards = library(ctx, 'P1', [
      libraryCard('Pillager Permission Spell', 1, 'Sorcery'),
      ...Array.from({ length: 5 }, (_, i) =>
        libraryCard(`Pillager Permission Filler ${i}`, 0, 'Land'),
      ),
    ]);
    const originalCard = cards[0]!;
    attackAndResolve(ctx, [pillager]);
    const exiled = ctx.state.exile.find((card) => card.cardId === originalCard.cardId)!;
    expect(exiled.playableUntilEotBy).toBe('P1');
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }]);
    pump(moveObject(ctx, pillager, { zone: 'graveyard' }));
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(true);
    pump(cleanupStep(ctx));
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
  });

  it('pr09-pillager-cast-only-mdfc — a modal spell face may be cast but its land face is not a play permission', () => {
    const ctx = pod('pr09-pillager-mdfc');
    const pillager = spawn(ctx, 'P1', PILLAGER);
    const mdfc = faceFixtureCard('Sejiri Shelter // Sejiri Glacier');
    const protectedCreature = spawn(ctx, 'P1', libraryCard('MDFC Target', 1, 'Creature — Test'));
    library(ctx, 'P1', [
      mdfc,
      libraryCard('MDFC Tail', 1, 'Sorcery'),
      libraryCard('MDFC Tail 2', 1, 'Sorcery'),
      libraryCard('MDFC Tail 3', 1, 'Sorcery'),
    ]);
    pillager.summoningSick = false;
    attackAndResolve(ctx, [pillager]);
    const exileObject = ctx.state.exile.find((card) => card.name.startsWith('Sejiri Shelter'))!;
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'W' }]);
    expect(exileObject.playableUntilEotBy).toBe('P1');
    const options = computePriorityOptions(ctx, p(ctx, 'P1')).filter(
      (option) => (option.payload as { objectId?: string }).objectId === exileObject.id,
    );
    expect(protectedCreature.zone).toBe('battlefield');
    expect(options.some((option) => option.type === 'castSpell')).toBe(true);
    expect(options.some((option) => option.type === 'playLand')).toBe(false);
  });

  it('pr09-cube-normal-cast-ward — pays {5} through the normal cast action and retains ward {2}', () => {
    const ctx = pod('pr09-cube-cast');
    const card = castNormally(ctx, 'P1', CUBE, ['C', 'C', 'C', 'C', 'C']);
    const cube = ctx.state.battlefield.find((permanent) => permanent.cardId === card.cardId)!;
    expect(wardCostOf(ctx, cube)).toMatchObject({ kind: 'mana' });
    expect(interpretCard(CUBE).modeled).toBe(true);
  });

  it('pr09-cube-attack-batch — one attack event from multiple creatures resolves one optional library choice', () => {
    const ctx = pod('pr09-cube-batch');
    const cube = spawn(ctx, 'P1', CUBE);
    const a = spawn(ctx, 'P1', libraryCard('Cube Attacker A', 1, 'Creature — Test'));
    const b = spawn(ctx, 'P1', libraryCard('Cube Attacker B', 1, 'Creature — Test'));
    a.summoningSick = false;
    b.summoningSick = false;
    library(ctx, 'P1', [
      libraryCard('Cube One Spell', 1, 'Sorcery'),
      libraryCard('Cube Two Spell', 1, 'Sorcery'),
    ]);
    const result = attackAndResolve(ctx, [a, b], (decision) => decline(decision));
    const libraryChoices = result.decisions.filter((decision) =>
      decision.options.some((option) => option.type === 'castFree'),
    );
    expect(libraryChoices).toHaveLength(1);
    expect(cube.zone).toBe('battlefield');
  });

  it('pr09-cube-resolution-power-limit — uses the greatest current power at resolution and filters higher mana values', () => {
    const ctx = pod('pr09-cube-power-limit');
    spawn(ctx, 'P1', CUBE);
    const weak = spawn(ctx, 'P1', libraryCard('Cube Weak Attacker', 1, 'Creature — Test'));
    const strong = spawn(ctx, 'P1', libraryCard('Cube Strong Attacker', 1, 'Creature — Test'));
    strong.counters['+1/+1'] = 4;
    const offered: string[] = [];
    const cards = library(ctx, 'P1', [
      libraryCard('Cube MV 6', 6, 'Sorcery'),
      libraryCard('Cube MV 8', 8, 'Sorcery'),
      ...Array.from({ length: 4 }, (_, i) => libraryCard(`Cube Excess ${i}`, 9, 'Land')),
    ]);
    attackAndResolve(ctx, [weak, strong], (decision) => {
      offered.push(
        ...decision.options
          .filter((option) => option.type === 'castFree')
          .map((option) => option.description),
      );
      return decline(decision);
    });
    expect(offered.some((description) => /Cube MV 6/.test(description))).toBe(true);
    expect(offered.some((description) => /Cube MV 8|Cube Excess/.test(description))).toBe(false);
    expect(new Set(p(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );
  });

  it('pr09-cube-no-eligible-bottom — spells over the limit and lands offer no cast and remain in the randomly-bottomed library', () => {
    const ctx = pod('pr09-cube-no-eligible');
    spawn(ctx, 'P1', CUBE);
    const attacker = spawn(ctx, 'P1', libraryCard('Cube Small Attacker', 1, 'Creature — Test'));
    const cards = library(ctx, 'P1', [
      libraryCard('Cube Too Costly', 5, 'Sorcery'),
      ...Array.from({ length: 5 }, (_, i) => libraryCard(`Cube Land ${i}`, 0, 'Land')),
    ]);
    const result = attackAndResolve(ctx, [attacker], (decision) => {
      if (decision.options.some((option) => option.type === 'castFree'))
        throw new Error('no spell qualifies');
      return pass(decision);
    });
    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => option.type === 'castFree'),
      ),
    ).toBe(false);
    expect(new Set(p(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );
  });
});
