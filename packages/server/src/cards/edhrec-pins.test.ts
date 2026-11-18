import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  MODELED_RATCHET_PATH,
  PINNED_ORACLE_PATH,
  definitionFingerprint,
  dumpDefinitions,
  modeledRatchet,
  pinReadyList,
  ratchetDrift,
  ratchetHolds,
  renderPins,
  type ModeledRatchet,
} from './edhrec-pins';
import type { EdhrecRanking } from './edhrec-ranking';
import { buildOracleIndexFromCards } from './oracle-index';

const root = resolve(import.meta.dirname, '../../../..');
const card = (name: string, oracleText: string): OracleCard => ({
  oracleId: `oracle-${name.toLowerCase().replace(/\W+/g, '-')}`,
  scryfallId: 'pin-test',
  name,
  manaCost: '{1}',
  cmc: 1,
  colors: [],
  colorIdentity: [],
  typeLine: 'Artifact',
  supertypes: [],
  types: ['Artifact'],
  subtypes: [],
  oracleText,
  power: null,
  toughness: null,
  loyalty: null,
  defense: null,
  keywords: [],
  layout: 'normal',
  commanderLegality: 'legal',
  isBasicLand: false,
});
const modeledCard = card('Pin Rock', '{T}: Add {C}.');
const oneLine = card('Pin Riddle', '{T}: Add {C}.\nThis artifact hums a tune no rule can read.');
const farAway = card(
  'Pin Mystery',
  'This artifact hums a tune no rule can read.\nIt also whistles a second unreadable tune.',
);
const ranking = {
  cards: [
    ['Pin Rock', 10, 'nonland'],
    ['Pin Mystery', 9, 'nonland'],
    ['Pin Riddle', 8, 'nonland'],
    ['Pin Absent', 7, 'nonland'],
  ],
} as unknown as EdhrecRanking;

describe('EDHREC offline pins (coverage plan D3)', () => {
  it('pins modeled and one-line cards by rank, skips the rest, and reports unresolved names', () => {
    const index = buildOracleIndexFromCards([modeledCard, oneLine, farAway]);
    const { pins, added, unresolved } = pinReadyList(ranking, index, []);
    expect(pins.map((pin) => [pin.rank, pin.card.name])).toEqual([
      [1, 'Pin Rock'],
      [3, 'Pin Riddle'],
    ]);
    expect(added).toEqual(['Pin Rock', 'Pin Riddle']);
    expect(unresolved).toEqual(['Pin Absent']);
  });

  it('never drops a pin, and refreshes a changed Oracle record', () => {
    const index = buildOracleIndexFromCards([{ ...modeledCard, oracleText: '{T}: Add {G}.' }]);
    const existing = [
      { rank: 1, card: modeledCard },
      { rank: 3, card: oneLine },
    ];
    const { pins, changed } = pinReadyList(ranking, index, existing);
    expect(pins.map((pin) => pin.card.name)).toEqual(['Pin Rock', 'Pin Riddle']);
    expect(pins[0]!.card.oracleText).toBe('{T}: Add {G}.');
    expect(changed).toEqual(['Pin Rock']);
  });

  it('flags a regressed card, an unrecorded modeled card, and a changed fixture', () => {
    const text = renderPins([
      { rank: 1, card: modeledCard },
      { rank: 3, card: oneLine },
    ]);
    const current = modeledRatchet(text);
    expect(current.modeled).toEqual(['Pin Rock']);
    const recorded: ModeledRatchet = { ...current, modeled: ['Pin Riddle'], fixtureSha256: 'x' };
    expect(ratchetDrift(recorded, current)).toEqual({
      regressed: ['Pin Riddle'],
      newlyModeled: ['Pin Rock'],
      behaviorChanged: [],
      fixtureChanged: true,
    });
  });

  it('flags a card that still models with a different definition', () => {
    const before = modeledRatchet(renderPins([{ rank: 1, card: modeledCard }]));
    // The same card, still modeled, now making green mana: only its definition differs.
    const changedCard = { ...modeledCard, oracleText: '{T}: Add {G}.' };
    const after = modeledRatchet(renderPins([{ rank: 1, card: changedCard }]));
    expect(after.modeled).toEqual(before.modeled);
    const drift = ratchetDrift(before, after);
    expect(drift.behaviorChanged).toEqual(['Pin Rock']);
    expect(drift.regressed).toEqual([]);
    expect(ratchetHolds(before, drift)).toBe(false);
    // A card is not reported as changed against itself.
    expect(ratchetDrift(before, before).behaviorChanged).toEqual([]);
  });

  it('a ratchet recorded without fingerprints does not hold', () => {
    const current = modeledRatchet(renderPins([{ rank: 1, card: modeledCard }]));
    const { fingerprints: _dropped, ...legacy } = current;
    const drift = ratchetDrift(legacy, current);
    expect(drift.behaviorChanged).toEqual([]);
    expect(ratchetHolds(legacy, drift)).toBe(false);
    expect(ratchetHolds(current, ratchetDrift(current, current))).toBe(true);
  });

  it('fingerprints ignore key order and nothing else', () => {
    expect(definitionFingerprint({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
      definitionFingerprint({ b: [{ d: 3, c: 2 }], a: 1 }),
    );
    expect(definitionFingerprint({ a: [1, 2] })).not.toBe(definitionFingerprint({ a: [2, 1] }));
    expect(definitionFingerprint({ description: 'x' })).not.toBe(
      definitionFingerprint({ description: 'y' }),
    );
  });

  it('dumps one line per modeled card, so two dumps diff card by card', () => {
    const dump = dumpDefinitions(
      renderPins([
        { rank: 1, card: modeledCard },
        { rank: 3, card: oneLine },
      ]),
    );
    const lines = dump.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('Pin Rock\t{')).toBe(true);
  });

  it('every pinned card that modeled when recorded still models the same way, and none is unrecorded', () => {
    const text = readFileSync(resolve(root, PINNED_ORACLE_PATH), 'utf8');
    const recorded = JSON.parse(
      readFileSync(resolve(root, MODELED_RATCHET_PATH), 'utf8'),
    ) as ModeledRatchet;
    const drift = ratchetDrift(recorded, modeledRatchet(text));
    expect(drift).toEqual({
      regressed: [],
      newlyModeled: [],
      behaviorChanged: [],
      fixtureChanged: false,
    });
    expect(ratchetHolds(recorded, drift)).toBe(true);
    // It interprets all 8,972 pinned cards (about 4 s alone); a loaded parallel run needs more
    // than the default 5 s.
  }, 60_000);
});
