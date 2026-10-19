import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { playerById } from '../src/state/objects';
import { conjure } from './fixtures';
import { searchPod, castSearch, settleSearch, shufflers } from './multiplayer-search-fixtures';
const pin = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards.find((entry) => entry.card.name === 'Scheming Symmetry')!;
const card = pin.card;
describe('PR08.04 Scheming Symmetry', () => {
  it('symmetry-two-distinct-targets-required — one living player cannot satisfy the announcement minimum', () => {
    const ctx = searchPod();
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    for (const player of ctx.state.players.filter((entry) => entry.id !== 'P1'))
      player.hasLost = true;
    expect(
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === object.id,
      ),
    ).toBe(false);
  });
  it('symmetry-single-card-libraries — mandatory searches preserve the only cards and still shuffle both libraries', () => {
    const ctx = searchPod();
    for (const id of ['P1', 'P2'])
      playerById(ctx, id).library = playerById(ctx, id).library.filter(
        (object) => object.name === `${id} Chosen Relic`,
      );
    castSearch(ctx, card);
    settleSearch(ctx);
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
    for (const id of ['P1', 'P2'])
      expect(playerById(ctx, id).library.map((object) => object.name)).toEqual([
        `${id} Chosen Relic`,
      ]);
  });
  it('symmetry-pinned-oracle-and-alias — both identities model exactly two player targets and the printed black sorcery', () => {
    expect(card.oracleId).toBe('6dfb50d7-359b-4644-90e3-7ecdacee7c12');
    expect(pin.sha256).toBe('9e799e443627ee3054fa6cf4b389234fd499ffe819f291da1d3e566ba6ad4ed7');
    expect(card.manaCost).toBe('{B}');
    for (const oracleId of [card.oracleId, fixtureOracleId(card.name)]) {
      const def = interpretCard({ ...card, oracleId });
      expect(def.modeled).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
      expect(validateCardDefinition(def)).toEqual([]);
      expect(def.spellAbility?.targets).toEqual([{ kind: 'player', count: { min: 2, max: 2 } }]);
      expect(def.spellAbility?.effects).toEqual([{ op: 'schemingSymmetry', targetSlot: 0 }]);
    }
  });
  it('symmetry-normal-cast-shuffle-before-top — pay black and each targeted player puts their own private selection above a shuffled remainder', () => {
    const ctx = searchPod();
    const before = new Map(ctx.state.players.map((player) => [player.id, [...player.library]]));
    const object = castSearch(ctx, card, ['P3', 'P1']);
    expect(settleSearch(ctx)).toEqual(['P1', 'P3']);
    expect(shufflers(ctx)).toEqual(['P1', 'P3']);
    for (const player of ctx.state.players) {
      if (['P1', 'P3'].includes(player.id)) {
        expect(player.library[0]?.name).toBe(`${player.id} Chosen Relic`);
        expect(new Set(player.library)).toEqual(new Set(before.get(player.id)));
      } else expect(player.library).toEqual(before.get(player.id));
    }
    expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === object.cardId)).toBe(
      true,
    );
  });
  it('symmetry-two-opponent-targets — the caster need not be either target and never sees an opponent library choice', () => {
    const ctx = searchPod();
    const mine = [...playerById(ctx, 'P1').library];
    castSearch(ctx, card, ['P4', 'P2']);
    expect(
      settleSearch(ctx, (decision) => {
        expect(decision.player).not.toBe('P1');
        expect(
          decision.options.every((option) => option.description.includes(`${decision.player} `)),
        ).toBe(true);
        expect(decision.options.some((option) => option.type === 'decline')).toBe(false);
      }),
    ).toEqual(['P2', 'P4']);
    expect(playerById(ctx, 'P1').library).toEqual(mine);
    expect(shufflers(ctx)).toEqual(['P2', 'P4']);
  });
  it('symmetry-black-mana-and-sorcery-timing — a colorless payment and another player turn do not offer the cast', () => {
    const ctx = searchPod();
    const object = conjure(ctx, 'P1', card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
    const offered = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (option) =>
          (option.payload as PriorityActionPayload).kind === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === object.id,
      );
    expect(offered()).toBe(false);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    expect(offered()).toBe(true);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offered()).toBe(false);
  });
  it('symmetry-target-domain — alive players including yourself are legal; opponent hexproof excludes that player', () => {
    const ctx = searchPod();
    const spec = interpretCard(card).spellAbility!.targets[0]!;
    expect(computeTargetOptions(ctx, spec, 'P1')).toEqual(['P1', 'P2', 'P3', 'P4']);
    ctx.state.playerHexproofTurn = { P1: 5, P2: 5 };
    playerById(ctx, 'P3').hasLost = true;
    expect(computeTargetOptions(ctx, spec, 'P1')).toEqual(['P1', 'P4']);
  });
  it('symmetry-one-illegal-target — the other player still searches and shuffles while the illegal target does neither', () => {
    const ctx = searchPod();
    castSearch(ctx, card);
    ctx.state.playerHexproofTurn = { P2: 5 };
    expect(settleSearch(ctx)).toEqual(['P1']);
    expect(shufflers(ctx)).toEqual(['P1']);
    expect(playerById(ctx, 'P2').library[0]?.name).toBe('P2 Last Relic');
  });
  it('symmetry-all-targets-illegal — the spell fizzles after mana payment with no search or shuffle', () => {
    const ctx = searchPod();
    castSearch(ctx, card, ['P2', 'P3']);
    ctx.state.playerHexproofTurn = { P2: 5, P3: 5 };
    expect(settleSearch(ctx)).toEqual([]);
    expect(shufflers(ctx)).toEqual([]);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });
  it('symmetry-empty-library-still-shuffles — an empty legal target needs no choice and still shuffles', () => {
    const ctx = searchPod();
    playerById(ctx, 'P2').library = [];
    castSearch(ctx, card);
    expect(settleSearch(ctx)).toEqual(['P1']);
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
    expect(playerById(ctx, 'P2').library).toEqual([]);
  });
  it('symmetry-stable-library-identities — found cards never leave the library or become new objects', () => {
    const ctx = searchPod();
    const chosen = playerById(ctx, 'P1').library.find((entry) => entry.name === 'P1 Chosen Relic')!;
    const original = { ...chosen };
    castSearch(ctx, card);
    settleSearch(ctx);
    expect(playerById(ctx, 'P1').library[0]).toBe(chosen);
    expect(chosen).toEqual(original);
    expect(
      ctx.state.eventLog.filter((event) => JSON.stringify(event.payload).includes(chosen.name)),
    ).toEqual([]);
  });
});
