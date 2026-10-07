import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';
import { SPELL_FACE_LAB_EXPECTATIONS } from './spell-face-lab-expectations';
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/selected-spell-faces-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };

describe('pinned selected-face real Lab scenarios', () => {
  it.each(SPELL_FACE_LAB_EXPECTATIONS)('normally plays the printed front of $name', (expected) => {
    const card = pins.cards.find(({ card }) => card.name.split(' // ')[0] === expected.name)!.card;
    const engine = finish(`${slug(expected.name)}-viewer-front`, expected.name, false, expected.x);
    const state = engine.getState();
    const view = engine.view('P1');
    const permanent = view.battlefield.find((permanent) => permanent.name === card.name)!;
    expect(permanent).toBeDefined();
    expect(permanent.typeLine).toBe(card.typeLine);
    if (card.power !== null)
      expect(permanent.power).toBe(
        Number(card.power) + (expected.name === "Imodane's Recruiter" ? 1 : 0),
      );
    if (card.toughness !== null) expect(permanent.toughness).toBe(Number(card.toughness));
    expect(state.exile.map((card) => card.name)).not.toContain(card.name);
    expect(state.players[0]!.hand).toHaveLength(expected.name === 'Bilbo Baggins, Burglar' ? 1 : 0);
    expect(view.life).toBe(expected.name === 'Sagu Wildling' ? 43 : 40);
    if (expected.name === 'Lindblum, Industrial Regency') expect(permanent.tapped).toBe(true);
    if (expected.name === 'Gingerbread Hunter')
      expect(view.battlefield.some((card) => card.name === 'Food')).toBe(true);
    if (expected.name === "Imodane's Recruiter") {
      const own = view.battlefield.find((card) => card.name === 'Own Face Bear')!;
      expect([own.power, own.toughness]).toEqual([3, 2]);
      expect(own.keywords).toContain('haste');
    }
    if (expected.name === 'An Unexpected Party')
      expect(view.battlefield.find((card) => card.name === 'Face Giant Witness')!.power).toBe(5);
  });

  it.each(SPELL_FACE_LAB_EXPECTATIONS)(
    'normally casts the independently pinned spell half of $name',
    (expected) => {
      const card = pins.cards.find(
        ({ card }) => card.name.split(' // ')[0] === expected.name,
      )!.card;
      const engine = finish(
        `${slug(card.backFace!.name)}-viewer-normal-face`,
        expected.name,
        true,
        expected.x,
      );
      const state = engine.getState();
      const view = engine.view('P1');
      const chosen = view.battlefield.find((card) => card.name === 'Chosen Face Bear');
      const own = view.battlefield.find((card) => card.name === 'Own Face Bear');
      if (expected.omen) {
        expect(state.players[0]!.library.map((card) => card.name)).toContain(card.name);
        expect(state.exile.map((card) => card.name)).not.toContain(card.name);
      } else {
        const exiled = state.exile.find((entry) => entry.name === card.name);
        expect(exiled && 'onAdventure' in exiled && exiled.onAdventure).toBe(true);
      }
      expect(state.players[0]!.graveyard.map((card) => card.name)).not.toContain(card.name);
      expect(view.battlefield.some((permanent) => permanent.name === card.name)).toBe(false);
      if (
        expected.destroyNonGiants ||
        expected.name === 'Gingerbread Hunter' ||
        expected.name === 'Smaug, the Great Calamity'
      )
        expect(chosen).toBeUndefined();
      else {
        expect(chosen).toBeDefined();
        if (expected.pt) expect([chosen!.power, chosen!.toughness]).toEqual(expected.pt);
        if (expected.keyword) expect(chosen!.keywords).toContain(expected.keyword);
        if (expected.counters !== undefined)
          expect(state.battlefield.find((p) => p.id === chosen!.id)!.counters['+1/+1']).toBe(
            expected.counters,
          );
        if (expected.damage !== undefined)
          expect(state.battlefield.find((p) => p.id === chosen!.id)!.damageMarked).toBe(
            expected.damage,
          );
        if (expected.untap) expect(chosen!.tapped).toBe(false);
      }
      if (expected.bounce) {
        expect(own).toBeUndefined();
        expect(view.hand.map((card) => card.name)).toContain('Own Face Bear');
      } else if (expected.destroyNonGiants) expect(own).toBeUndefined();
      else expect([own!.power, own!.toughness]).toEqual([2, 2]);
      expect(view.battlefield.some((p) => p.name === 'Face Giant Witness')).toBe(true);
      if (expected.ownKeyword) expect(own!.keywords).toContain(expected.ownKeyword);
      if (expected.destroyArtifact)
        expect(view.battlefield.some((p) => p.name === 'Chosen Face Artifact')).toBe(false);
      if (expected.tokens !== undefined) {
        const tokens = view.battlefield.filter((p) => p.name === expected.tokenName);
        expect(tokens).toHaveLength(expected.tokens);
        for (const token of tokens) {
          if (expected.tokenPt) expect([token.power, token.toughness]).toEqual(expected.tokenPt);
          if (expected.tokenKeyword) expect(token.keywords).toContain(expected.tokenKeyword);
        }
      }
      expect(view.life).toBe(expected.life ?? 40);
      expect(view.hand).toHaveLength(
        (expected.draw ?? 0) -
          (expected.discard ?? 0) +
          (expected.search || expected.bounce ? 1 : 0),
      );
      if (expected.discard) expect(view.graveyard).toHaveLength(expected.discard);
      if (expected.scry !== undefined)
        expect(state.eventLog.find((event) => event.type === 'scry')?.payload['looked']).toBe(
          expected.scry,
        );
      if (expected.opponentsOnly)
        expect(state.battlefield.find((p) => p.name === 'Own Face Bear')!.damageMarked).toBe(0);
    },
  );
});

function finish(id: string, name: string, half: boolean, x?: number) {
  const engine = createCardTestScenario(id, `lab-test-${id}`)!.engine;
  let played = false;
  let ended = false;
  for (let count = 0; count < 150; count++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') {
      ended = true;
      break;
    }
    if (step.kind !== 'decision') continue;
    const request = step.request;
    const main =
      !played &&
      request.decidingPlayer === 'P1' &&
      request.legalActions.find(
        (action) =>
          ['castSpell', 'playLand'].includes(action.type) &&
          action.data?.['sourceName'] ===
            pins.cards.find(({ card }) => card.name.split(' // ')[0] === name)!.card.name &&
          (action.data?.['castVariant'] !== undefined) === half &&
          (!half || x === undefined || action.description.includes(`X=${x}`)),
      );
    const action =
      main ||
      request.legalActions.find(
        (action) => action.type === 'chooseOption' && action.description === 'Giant',
      ) ||
      request.legalActions.find((action) => action.type === 'pass') ||
      request.legalActions[0]!;
    if (main) played = true;
    const targetName =
      name === 'Shepherd of the Flock'
        ? 'Own Face Bear'
        : name === 'Embereth Shieldbreaker'
          ? 'Chosen Face Artifact'
          : 'Chosen Face Bear';
    const targets =
      action.targets?.map((slot) => ({
        slot: slot.slot,
        choice: slot.options.find((id) =>
          engine.view('P1').battlefield.some((p) => p.id === id && p.name === targetName),
        )!,
      })) ?? [];
    engine.submit({ requestId: request.requestId, actionId: action.id, targets });
  }
  expect(played).toBe(true);
  expect(ended).toBe(true);
  return engine;
}
