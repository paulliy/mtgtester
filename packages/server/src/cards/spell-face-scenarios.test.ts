import { describe, expect, it } from 'vitest';
import { strictCardTestScenario } from './card-test-scenarios';
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
  const engine = strictCardTestScenario(id, `lab-test-${id}`)!.engine;
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

it('face-commander-lab normally casts and resolves Easy Pickings as a commander spell', () => {
  const engine = finish('easy-pickings-viewer-commander-face', 'Glóin the Mighty', true);
  const event = engine.getState().eventLog.find((event) => event.type === 'castSpell')!;
  expect(event.payload['commanderTax']).toBe(0);
  expect(engine.getState().players[0]!.commanderCastCount).toEqual(
    expect.objectContaining({
      [Object.keys(engine.getState().players[0]!.commanderCastCount)[0]!]: 1,
    }),
  );
  expect(
    engine
      .getState()
      .eventLog.some((event) => event.type === 'damage' && event.payload['amount'] === 1),
  ).toBe(true);
});

it('face-commander-stack-lab retains a real response choice while Easy Pickings is on the public stack', () => {
  const engine = strictCardTestScenario(
    'easy-pickings-viewer-commander-face',
    'commander-stack-lab',
  )!.engine;
  const opening = engine.advance();
  expect(opening.kind).toBe('decision');
  if (opening.kind !== 'decision') throw new Error('missing normal commander announcement');
  const action = opening.request.legalActions.find(
    (action) => action.data?.['castVariant'] === 'adventure',
  )!;
  expect(action.description).toContain('Easy Pickings');
  engine.submit({ requestId: opening.request.requestId, actionId: action.id });
  const response = engine.advance();
  expect(response.kind).toBe('decision');
  expect(engine.spectatorState().stack.map((spell) => spell.description)).toEqual([
    'Easy Pickings',
  ]);
  if (response.kind !== 'decision') throw new Error('missing normal response priority');
  expect(
    response.request.legalActions.some(
      (action) =>
        action.type === 'castSpell' &&
        action.description.includes('Independent Commander Response'),
    ),
  ).toBe(true);
});

it.each(['Foulmire Knight', 'Sagu Wildling'])(
  'face-impulse-lab — casts the pinned spell half of %s through a normal temporary permission',
  (name) => {
    const pin = pins.cards.find(({ card }) => card.name.startsWith(name))!.card;
    const engine = strictCardTestScenario(
      `${slug(pin.backFace!.name)}-viewer-impulse-face`,
      `impulse-lab-${slug(name)}`,
    )!.engine;
    let impulse = false,
      face = false,
      ended = false;
    for (let count = 0; count < 100; count++) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        ended = true;
        break;
      }
      if (step.kind !== 'decision') continue;
      const request = step.request;
      const main =
        request.decidingPlayer === 'P1' &&
        request.legalActions.find(
          (action) =>
            action.type === 'castSpell' &&
            ((!impulse && action.description.includes('Independent Impulse Permission')) ||
              (impulse &&
                !face &&
                action.data?.['castVariant'] ===
                  (name === 'Sagu Wildling' ? 'omen' : 'adventure'))),
        );
      const action =
        main ||
        request.legalActions.find((action) => action.type === 'pass') ||
        request.legalActions[0]!;
      if (main) {
        if (!impulse) impulse = true;
        else face = true;
      }
      engine.submit({ requestId: request.requestId, actionId: action.id });
    }
    expect(impulse && face && ended).toBe(true);
    expect(engine.view('P1').hand).toHaveLength(2);
    expect(engine.getState().battlefield.some((card) => card.name === pin.name)).toBe(false);
    if (name === 'Foulmire Knight') {
      expect(engine.view('P1').life).toBe(39);
      expect(engine.getState().exile.some((card) => card.name === pin.name)).toBe(true);
    } else {
      expect(engine.getState().players[0]!.library.some((card) => card.name === pin.name)).toBe(
        true,
      );
      expect(engine.view('P1').hand.some((card) => card.typeLine?.includes('Basic Land'))).toBe(
        true,
      );
    }
  },
);
