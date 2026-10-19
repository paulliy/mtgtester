import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { spell } from '../src/cards/templates';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { playerById } from '../src/state/objects';
import { registerCustomDef, oracle } from './fixtures';
import { castSearch, searchPod, settleSearch, shufflers } from './multiplayer-search-fixtures';
import type { CardDefinition } from '../src/cards/definition';

function fixture(ctx: ReturnType<typeof searchPod>) {
  const card = oracle({
    name: 'Independent paired-library tutor',
    typeLine: 'Instant',
    manaCost: '{B}',
    oracleText:
      'Choose two target players. Each of them searches their library for a card, then shuffles and puts that card on top.',
  });
  const interpreted = interpretCard(card);
  expect(interpreted.unmodeledReasons).toHaveLength(1);
  const remaining = interpreted.unmodeledReasons.filter(
    (reason) => !reason.includes(card.oracleText),
  );
  expect(remaining).toEqual([]);
  const definition: CardDefinition = {
    ...interpreted,
    modeled: remaining.length === 0,
    unmodeledReasons: remaining,
    spellAbility: spell({
      targets: [{ kind: 'player', count: { min: 2, max: 2 } }],
      effects: [{ op: 'schemingSymmetry', targetSlot: 0 }],
    }),
  };
  expect(validateCardDefinition(definition)).toEqual([]);
  registerCustomDef(ctx, definition);
  return { card, definition };
}

describe('independent multiplayer library-search contract', () => {
  it('multiplayer-search-seeded-permutation — the remainder really shuffles and the selected card stays outside that permutation', () => {
    const ctx = searchPod('search-permutation-regression');
    const { card } = fixture(ctx);
    castSearch(ctx, card);
    const expectedRng = ctx.rng.clone();
    const expected = ['P1', 'P2'].map((id) => {
      const library = playerById(ctx, id).library;
      const chosen = library.find((object) => object.name === `${id} Chosen Relic`)!;
      const rest = library.filter((object) => object !== chosen);
      expectedRng.shuffle(rest);
      return [chosen, ...rest];
    });
    settleSearch(ctx);
    expect(playerById(ctx, 'P1').library).toEqual(expected[0]);
    expect(playerById(ctx, 'P2').library).toEqual(expected[1]);
    expect(ctx.rng.nextUint32()).toBe(expectedRng.nextUint32());
  });
  it('multiplayer-search-real-stack — each player chooses their own card and the selected identities are preserved on top', () => {
    const ctx = searchPod('independent-paired-search');
    const { card } = fixture(ctx);
    const selected = ['P1', 'P2'].map((id) =>
      playerById(ctx, id).library.find((object) => object.name === `${id} Chosen Relic`)!,
    );
    castSearch(ctx, card);
    expect(settleSearch(ctx)).toEqual(['P1', 'P2']);
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
    expect(playerById(ctx, 'P1').library[0]).toBe(selected[0]);
    expect(playerById(ctx, 'P2').library[0]).toBe(selected[1]);
  });
  it('multiplayer-search-apnap — search order starts at the active player rather than the caster or selected target order', () => {
    const ctx = searchPod();
    const { card } = fixture(ctx);
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    castSearch(ctx, card, ['P2', 'P4']);
    expect(settleSearch(ctx)).toEqual(['P4', 'P2']);
    expect(shufflers(ctx)).toEqual(['P4', 'P2']);
  });
  it('multiplayer-search-all-choices-before-shuffles — every hidden selection precedes the shuffle stage', () => {
    const ctx = searchPod();
    const { card } = fixture(ctx);
    const before = ctx.state.players.map((player) => [...player.library]);
    castSearch(ctx, card);
    settleSearch(ctx, () => {
      expect(shufflers(ctx)).toEqual([]);
      expect(ctx.state.players.map((player) => player.library)).toEqual(before);
    });
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
  });
  it('multiplayer-search-empty-both — both empty libraries shuffle without a search menu', () => {
    const ctx = searchPod();
    const { card } = fixture(ctx);
    playerById(ctx, 'P1').library = [];
    playerById(ctx, 'P2').library = [];
    castSearch(ctx, card);
    expect(settleSearch(ctx)).toEqual([]);
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
  });
  it('multiplayer-search-private-found-cards — searching does not reveal the identities to the public event stream', () => {
    const ctx = searchPod();
    const { card } = fixture(ctx);
    castSearch(ctx, card, ['P2', 'P3']);
    settleSearch(ctx);
    for (const event of ctx.state.eventLog)
      expect(JSON.stringify(event.payload)).not.toMatch(/Chosen Relic/);
  });
  it('multiplayer-search-reference-validation — only a counted player target slot can bind the search', () => {
    const ctx = searchPod();
    const { definition } = fixture(ctx);
    for (const targets of [
      [{ kind: 'player' as const }],
      [{ kind: 'creature' as const, count: { min: 2, max: 2 } }],
      [],
    ]) {
      const malformed = structuredClone(definition);
      malformed.spellAbility!.targets = targets;
      expect(validateCardDefinition(malformed).length).toBeGreaterThan(0);
    }
    for (const slot of [-1, 1, 0.5, NaN]) {
      const malformed = structuredClone(definition);
      malformed.spellAbility!.effects = [{ op: 'schemingSymmetry', targetSlot: slot }];
      expect(validateCardDefinition(malformed).length).toBeGreaterThan(0);
    }
  });
});
