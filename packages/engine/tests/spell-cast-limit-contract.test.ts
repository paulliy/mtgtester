import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { freeCardIsCastable, resolveFreeCard } from '../src/casting/free';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlStaxOverrides } from '../src/cards/overrides/white-black-control-stax';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { runTurn } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

type PinnedFixture = { cards: { card: OracleCard }[] };
const pins = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as PinnedFixture;
const law = pins.cards.find(({ card }) => card.name === 'Rule of Law')!.card;
const silence = pins.cards.find(({ card }) => card.name === 'Deafening Silence')!.card;
const facePins = JSON.parse(
  readFileSync(new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as PinnedFixture;
const foulmire = facePins.cards.find(({ card }) => card.name.startsWith('Foulmire Knight'))!.card;

registerWhiteBlackControlStaxOverrides();

function context(seed = 'spell-cast-limit-contract'): GameContext {
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
  return ctx;
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function ruleSource(
  ctx: GameContext,
  category: 'any' | 'noncreature',
  name = `Test ${category} Limit`,
) {
  const printed = oracle({
    name,
    typeLine: 'Enchantment',
    manaCost: null,
    power: null,
    toughness: null,
  });
  const def = structuredClone(interpretCard(printed));
  def.ruleStatics = [{ kind: 'spellCastLimit', category, limit: 1 }];
  ctx.defs.set(def.oracleId, def);
  return spawn(ctx, 'P1', printed);
}

function spellCard(name: string, typeLine = 'Instant'): OracleCard {
  const creature = typeLine.includes('Creature');
  return oracle({
    name,
    typeLine,
    manaCost: '{0}',
    oracleText: creature ? '' : 'You gain 1 life.',
    power: creature ? '2' : null,
    toughness: creature ? '2' : null,
  });
}

function castFromHand(ctx: GameContext, playerId: string, printed: OracleCard): void {
  const card = conjure(ctx, playerId, printed, 'hand');
  const activePlayer = player(ctx, playerId);
  const option = computePriorityOptions(ctx, activePlayer).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
  if (option === undefined) throw new Error(`No legal cast option for ${printed.name}`);
  pump(
    applyPriorityAction(ctx, activePlayer, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  pump(resolveTopOfStack(ctx));
}

function canCast(ctx: GameContext, playerId: string, printed: OracleCard): boolean {
  const card = conjure(ctx, playerId, printed, 'hand');
  return computePriorityOptions(ctx, player(ctx, playerId)).some((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
}

describe('spellCastLimit rule-static contract', () => {
  it('counts the player before source entry, keeps players independent, and restores casts when the source leaves', () => {
    const ctx = context();
    castFromHand(ctx, 'P1', spellCard('Before Law'));
    const lawSource = ruleSource(ctx, 'any');

    expect(canCast(ctx, 'P1', spellCard('P1 Second'))).toBe(false);
    castFromHand(ctx, 'P2', spellCard('P2 First'));
    expect(canCast(ctx, 'P2', spellCard('P2 Second'))).toBe(false);

    pump(moveObject(ctx, lawSource, { zone: 'exile' }));
    expect(canCast(ctx, 'P1', spellCard('After Law Leaves'))).toBe(true);
  });

  it('noncreature limits allow creature and artifact creature spells after one noncreature cast', () => {
    const ctx = context();
    const source = ruleSource(ctx, 'noncreature');
    castFromHand(ctx, 'P1', spellCard('First Noncreature'));

    expect(canCast(ctx, 'P1', spellCard('Second Noncreature'))).toBe(false);
    expect(canCast(ctx, 'P1', spellCard('Allowed Creature', 'Creature — Bear'))).toBe(true);
    expect(
      canCast(ctx, 'P1', spellCard('Allowed Artifact Creature', 'Artifact Creature — Golem')),
    ).toBe(true);
    expect(canCast(ctx, 'P2', spellCard('Other Player Noncreature'))).toBe(true);

    // Keep the source live through this assertion so the test also proves these are category-
    // selected checks rather than a stale legality result computed once at source entry.
    expect(ctx.state.battlefield).toContain(source);
  });

  it('resets both cast tallies at the next untap step', () => {
    const ctx = context();
    ruleSource(ctx, 'any');
    castFromHand(ctx, 'P1', spellCard('This Turn'));
    expect(player(ctx, 'P1').spellsCastThisTurn).toBe(1);
    expect(canCast(ctx, 'P1', spellCard('Still This Turn'))).toBe(false);

    pump(runTurn(ctx), (_decision) => ({ index: 0, targets: new Map() }));
    expect(player(ctx, 'P1').spellsCastThisTurn).toBe(0);
    expect(player(ctx, 'P1').noncreatureSpellsCastThisTurn).toBe(0);
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P1',
      activePlayerIndex: 0,
      phase: 'precombatMain',
      step: null,
    });
    expect(canCast(ctx, 'P1', spellCard('Next Turn'))).toBe(true);
  });

  it('checks free-cast permissions and an Adventure face using the selected face type', () => {
    const ctx = context();
    castFromHand(ctx, 'P1', spellCard('First Noncreature'));
    ruleSource(ctx, 'noncreature');
    const locked = conjure(ctx, 'P1', spellCard('Free Noncreature'), 'exile');
    expect(freeCardIsCastable(ctx, locked, 'P1')).toBe(false);

    const adventure = conjure(ctx, 'P1', foulmire, 'exile');
    expect(freeCardIsCastable(ctx, adventure, 'P1')).toBe(true); // front face is a creature
    const freeCastFlow = resolveFreeCard(ctx, adventure, 'P1');
    const offered = freeCastFlow.next();
    expect(offered.done).toBe(false);
    const options = offered.done ? [] : offered.value.options.map((option) => option.description);
    expect(options).toEqual([`Cast ${foulmire.name}`]);
  });

  it('casts the pinned Rule of Law and then blocks the same player’s second spell', () => {
    const ctx = context();
    const p1 = player(ctx, 'P1');
    const inHand = conjure(ctx, 'P1', law, 'hand');
    addMana(p1, [{ symbol: 'W' }, { symbol: 'C' }, { symbol: 'C' }]);
    const option = computePriorityOptions(ctx, p1).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === inHand.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(p1.spellsCastThisTurn).toBe(1);
    expect(canCast(ctx, 'P1', spellCard('Blocked by Rule of Law'))).toBe(false);
    expect(canCast(ctx, 'P2', spellCard('P2 Is Independent'))).toBe(true);
  });

  it('casts pinned Deafening Silence and permits creature spells after its noncreature limit', () => {
    const ctx = context();
    const p1 = player(ctx, 'P1');
    const inHand = conjure(ctx, 'P1', silence, 'hand');
    addMana(p1, [{ symbol: 'W' }]);
    const option = computePriorityOptions(ctx, p1).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === inHand.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p1, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(canCast(ctx, 'P1', spellCard('Blocked Instant'))).toBe(false);
    expect(canCast(ctx, 'P1', spellCard('Allowed Creature', 'Creature — Bear'))).toBe(true);
  });
});
