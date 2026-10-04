import { describe, expect, it } from 'vitest';
import { parseBenchmarkCase } from './contracts';

type MutablePrivacyFixture = {
  input: {
    view: Record<string, unknown> & { opponents: Record<string, unknown>[] };
  };
};
const malformedFixture = () => structuredClone(example) as unknown as MutablePrivacyFixture;

const example = {
  schemaVersion: 1,
  caseId: 'privacy-001',
  contentHash: 'pending',
  role: 'tactician',
  categories: [],
  sourceGroup: 'test',
  observerSeat: 'P1',
  turn: 1,
  phase: 'main',
  step: null,
  eventSequence: 1,
  supportedEngineVersion: 'engine',
  supportedCardDefinitionHash: 'cards',
  input: {
    request: { decidingPlayer: 'P1', kind: 'priority', options: [] },
    view: {
      seat: 'P1',
      life: 40,
      hand: [{ id: 'own', name: 'Own card' }],
      deck: [{ id: 'own-deck', name: 'Own deck card' }],
      graveyard: [],
      commanders: [],
      availableMana: {},
      manaSources: [],
      opponents: [
        {
          seat: 'P2',
          life: 40,
          handSize: 2,
          librarySize: 90,
          graveyard: [],
          commanders: [],
          poisonCounters: 0,
          commanderDamageDealtToYou: 0,
        },
      ],
      battlefield: [],
      exile: [],
      stack: [],
      recentLog: [],
    },
    guidance: {},
  },
};

describe('benchmark view privacy', () => {
  it.each([
    'caseId',
    'contentHash',
    'role',
    'categories',
    'sourceGroup',
    'observerSeat',
    'turn',
    'phase',
    'step',
    'eventSequence',
    'supportedEngineVersion',
    'supportedCardDefinitionHash',
    'input',
  ])('requires declared case field %s', (key) => {
    const value = structuredClone(example) as unknown as Record<string, unknown>;
    delete value[key];
    expect(() => parseBenchmarkCase(value)).toThrow();
  });
  it('allows only the declared optional PlayerView omissions', () => {
    const value = malformedFixture();
    Object.assign(value.input.view, {});
    delete value.input.view['energy'];
    delete value.input.view['revealedLibraryTops'];
    expect(() => parseBenchmarkCase(value)).not.toThrow();
    for (const key of [
      'life',
      'availableMana',
      'manaSources',
      'battlefield',
      'exile',
      'stack',
      'recentLog',
    ]) {
      const missing = structuredClone(value);
      delete missing.input.view[key];
      expect(() => parseBenchmarkCase(missing)).toThrow();
    }
  });
  it('validates numeric ranges and nested view shapes', () => {
    const mutations: Array<(value: MutablePrivacyFixture) => void> = [
      (v) => {
        v.input.view['life'] = NaN;
      },
      (v) => {
        v.input.view['availableMana'] = { W: Infinity };
      },
      (v) => {
        v.input.view['availableMana'] = { W: -1 };
      },
      (v) => {
        v.input.view['energy'] = 1.5;
      },
      (v) => {
        v.input.view['manaSources'] = [{ name: 'Land', symbols: ['G'], count: 0.5 }];
      },
      (v) => {
        v.input.view.opponents[0]!['handSize'] = -1;
      },
      (v) => {
        v.input.view.opponents[0]!['life'] = Infinity;
      },
      (v) => {
        v.input.view.opponents[0]!['poisonCounters'] = 0.5;
      },
      (v) => {
        v.input.view['commanders'] = [{ name: 'Cmd', zone: 'command', castCount: -1 }];
      },
      (v) => {
        v.input.view['hand'] = [{ id: 'c', name: 'Card', power: Infinity }];
      },
      (v) => {
        v.input.view['battlefield'] = [
          { id: 'p', controller: 'P1', name: 'P', tapped: false, status: [], power: NaN },
        ];
      },
      (v) => {
        v.input.view['battlefield'] = [
          { id: 'p', controller: 'P1', name: 'P', tapped: false, status: [], keywords: [1] },
        ];
      },
      (v) => {
        v.input.view['stack'] = [
          { id: 's', controller: 'P1', description: 'x', targets: [], extra: true },
        ];
      },
      (v) => {
        v.input.view['revealedLibraryTops'] = [
          { player: 'P2', card: { id: 'x', name: 'X', toughness: NaN } },
        ];
      },
    ];
    for (const mutate of mutations) {
      const value = malformedFixture();
      mutate(value);
      expect(() => parseBenchmarkCase(value)).toThrow();
    }
  });
  it('preserves authorized own hand and deck fields', () => {
    expect(parseBenchmarkCase(structuredClone(example)).input.view['hand'][0]?.name).toBe(
      'Own card',
    );
  });
  it('requires the observer seat to match the view seat', () => {
    const value = malformedFixture();
    value.input.view['seat'] = 'P2';
    expect(() => parseBenchmarkCase(value)).toThrow(/view.seat|observerSeat/);
  });
  it.each(['privateCards', 'library', 'opponentDecklists'])(
    'rejects unknown view key %s',
    (key) => {
      const value = structuredClone(example) as unknown as {
        input: { view: Record<string, unknown> };
      };
      value.input.view[key] = ['private'];
      expect(() => parseBenchmarkCase(value)).toThrow(/view/i);
    },
  );
  it.each(['hand', 'deck', 'library', 'libraryOrder', 'decklist'])('rejects opponent %s', (key) => {
    const value = structuredClone(example) as unknown as {
      input: { view: { opponents: Record<string, unknown>[] } };
    };
    value.input.view['opponents'][0]![key] = [{ name: 'secret' }];
    expect(() => parseBenchmarkCase(value)).toThrow(/opponent/i);
  });

  it('preserves documented full viewer card, commander, permanent, stack, and reveal data', () => {
    const value = malformedFixture();
    value.input.view['hand'] = [
      {
        id: 'h',
        name: 'Hand',
        manaCost: '{1}',
        typeLine: 'Creature',
        oracleText: 'Text',
        power: 2,
        toughness: 3,
      },
    ];
    value.input.view['commanders'] = [
      {
        name: 'Cmd',
        zone: 'command',
        castCount: 1,
        manaCost: '{3}',
        typeLine: 'Legendary Creature',
        oracleText: 'Text',
      },
    ];
    value.input.view['battlefield'] = [
      {
        id: 'p',
        controller: 'P1',
        name: 'Perm',
        typeLine: 'Creature',
        oracleText: 'Text',
        power: 2,
        toughness: 3,
        keywords: ['flying'],
        tapped: false,
        status: [],
        blockedBy: ['b'],
      },
    ];
    value.input.view['exile'] = [{ id: 'x', name: 'Exiled' }];
    value.input.view['stack'] = [
      { id: 's', controller: 'P1', description: 'spell', targets: ['p'] },
    ];
    value.input.view['revealedLibraryTops'] = [
      {
        player: 'P2',
        card: {
          id: 'top',
          name: 'Revealed',
          manaCost: '{2}',
          typeLine: 'Sorcery',
          oracleText: 'Text',
        },
      },
    ];
    expect(() => parseBenchmarkCase(value)).not.toThrow();
  });

  it.each([
    ['graveyard', { id: 'g', name: 'Known', oracleText: 'Private detail' }],
    ['commanders', { name: 'Cmd', zone: 'command', castCount: 0, decklist: ['secret'] }],
  ])('rejects undeclared nested opponent %s card/object keys', (zone, entry) => {
    const value = structuredClone(example) as unknown as {
      input: { view: Record<string, unknown> & { opponents: Record<string, unknown>[] } };
    };
    value.input.view['opponents'][0]![zone] = [entry];
    expect(() => parseBenchmarkCase(value)).toThrow(/unknown opponent/i);
  });

  it('rejects arbitrary nested objects and private fields inside opponent data', () => {
    const value = structuredClone(example) as unknown as {
      input: { view: Record<string, unknown> & { opponents: Record<string, unknown>[] } };
    };
    value.input.view['opponents'][0]!['graveyard'] = [
      { id: 'g', name: 'Known', nested: { decklist: ['secret'] } },
    ];
    expect(() => parseBenchmarkCase(value)).toThrow(/opponent|card/i);
  });

  it('validates revealed library top card shape', () => {
    const value = structuredClone(example) as unknown as {
      input: { view: Record<string, unknown> & { opponents: Record<string, unknown>[] } };
    };
    value.input.view['revealedLibraryTops'] = [
      { player: 'P2', card: { id: 'top', name: 'Known', decklist: ['secret'] } },
    ];
    expect(() => parseBenchmarkCase(value)).toThrow(/card|view/i);
  });

  it.each([
    ['hand', [{ id: 'h', name: 'Known', nested: { private: true } }]],
    [
      'battlefield',
      [{ id: 'p', controller: 'P2', name: 'Perm', tapped: false, status: [], private: {} }],
    ],
    ['exile', [{ id: 'x', name: 'Exiled', private: { card: true } }]],
    ['stack', [{ id: 's', controller: 'P2', description: 'spell', targets: [], extra: {} }]],
    ['revealedLibraryTops', [{ player: 'P2', card: { id: 'top', name: 'Known', extra: {} } }]],
  ])('rejects undeclared nested viewer shape in %s', (field, entries) => {
    const value = structuredClone(example) as unknown as {
      input: { view: Record<string, unknown> };
    };
    value.input.view[field] = entries;
    expect(() => parseBenchmarkCase(value)).toThrow(/unknown/i);
  });

  it('preserves actual public opponent graveyard and commander data', () => {
    const value = structuredClone(example) as unknown as {
      input: { view: Record<string, unknown> & { opponents: Record<string, unknown>[] } };
    };
    value.input.view['opponents'][0]!['graveyard'] = [{ id: 'g', name: 'Known' }];
    value.input.view['opponents'][0]!['commanders'] = [
      {
        name: 'Cmd',
        zone: 'graveyard',
        castCount: 2,
        manaCost: '{3}',
        typeLine: 'Legendary Creature',
        oracleText: 'Public text',
      },
    ];
    expect(() => parseBenchmarkCase(value)).not.toThrow();
  });
});
