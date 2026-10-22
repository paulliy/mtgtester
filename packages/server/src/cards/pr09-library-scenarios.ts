import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

type Pin = { sha256: string; card: OracleCard };
const pins = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/engine/tests/fixtures/coverage-pr09-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;
const coverage = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];
for (const item of pins)
  if (createHash('sha256').update(JSON.stringify(item.card)).digest('hex') !== item.sha256)
    throw new Error(`PR09 Oracle pin drift: ${item.card.name}`);
const pinned = (name: string): Pin => {
  const found = pins.find((item) => item.card.name === name);
  if (!found) throw new Error(`Missing PR09 Oracle pin ${name}`);
  return found;
};
const basic = (name: string): OracleCard => {
  const found = coverage.find((card) => card.name === name);
  if (!found) throw new Error(`Missing PR09 library support card ${name}`);
  return found;
};
const names = [
  ['mystic-forge', 'Mystic Forge'],
  ['songbirds-blessing', "Songbirds' Blessing"],
  ['etali', 'Etali, Primal Conqueror // Etali, Primal Sickness'],
  ['sunbirds-invocation', "Sunbird's Invocation"],
  ['minds-dilation', "Mind's Dilation"],
  ['expressive-iteration', 'Expressive Iteration'],
  ['genesis-ultimatum', 'Genesis Ultimatum'],
  ['into-the-time-vortex', 'Into the Time Vortex'],
] as const;
type Slug = (typeof names)[number][0];
const cards = Object.fromEntries(names.map(([slug, name]) => [slug, pinned(name)])) as Record<
  Slug,
  Pin
>;
const cases = names.flatMap(([slug, cardName]) => [
  {
    id: `pr09-${slug}-viewer-positive`,
    title: `${cardName}: resolve through the normal cast path`,
    cardName,
  },
  {
    id: `pr09-${slug}-viewer-negative`,
    title: `${cardName}: resolve with no eligible library card`,
    cardName,
  },
]);
cases.push({
  id: 'pr09-mystic-forge-viewer-activation',
  title: 'Mystic Forge: activate the top-card exile ability',
  cardName: 'Mystic Forge',
});
cases.push({
  id: 'pr09-etali-primal-conqueror-etali-primal-sickness-viewer-transform',
  title: 'Etali, Primal Conqueror // Etali, Primal Sickness: transform and attack',
  cardName: 'Etali, Primal Conqueror // Etali, Primal Sickness',
});
export const PR09_LIBRARY_SCENARIOS = cases;
const oracleSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
function exercisedOracleClauseIndexes(id: string, slug: Slug): number[] {
  if (slug === 'mystic-forge') return id.endsWith('activation') ? [2] : [0, 1];
  if (slug === 'songbirds-blessing') return [0, 1];
  if (slug === 'etali') return id.endsWith('viewer-transform') ? [2, 3, 4] : [0, 1];
  return Array.from(
    { length: cards[slug].card.oracleText.split(/\r?\n/).length },
    (_, index) => index,
  );
}

const lab = (
  name: string,
  typeLine: string,
  manaCost: string | null = '{1}',
  oracleText = '',
): OracleCard => {
  const base = basic('Forest');
  const types = typeLine
    .split(' — ')[0]!
    .split(' ')
    .filter((word) =>
      [
        'Artifact',
        'Creature',
        'Enchantment',
        'Instant',
        'Land',
        'Planeswalker',
        'Sorcery',
      ].includes(word),
    );
  const subtypes = typeLine.includes(' — ') ? typeLine.split(' — ')[1]!.split(' ') : [];
  return {
    ...base,
    oracleId: `lab-pr09-library-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `lab-pr09-library-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    manaCost,
    cmc: manaCost?.match(/\{[WUBRG]\}/g)?.length ?? Number(manaCost?.match(/\{(\d+)\}/)?.[1] ?? 0),
    colors: [],
    colorIdentity: [],
    typeLine,
    types,
    supertypes: [],
    subtypes,
    oracleText,
    power: types.includes('Creature') ? '2' : null,
    toughness: types.includes('Creature') ? '2' : null,
    keywords: [],
    isBasicLand: types.includes('Land'),
  };
};

/** Source-pinned prepared Card Test Lab scenarios for the PR09 library cards. */
export function pr09LibraryScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cases.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown PR09 library scenario ${id}`);
  const slug = names.find(([, cardName]) => cardName === entry.cardName)![0];
  const pin = cards[slug];
  const positive = id.endsWith('positive') || id.endsWith('activation');
  const transform = id.endsWith('viewer-transform');
  const forgeActivation = id.endsWith('activation');
  const host = lab('PR09 Library Host', 'Creature — Bird', '{2}');
  const spell = lab('PR09 Library Spell', 'Sorcery', '{1}', 'You gain 1 life.');
  const miss = lab('PR09 Library Miss', 'Land', null);
  const aura = lab('PR09 Library Aura', 'Enchantment — Aura', '{1}{W}', 'Enchant creature');
  const libraryCard =
    slug === 'songbirds-blessing'
      ? positive
        ? [aura, miss, spell]
        : [miss, spell]
      : slug === 'mystic-forge'
        ? positive
          ? [lab('PR09 Forge Artifact', 'Artifact', '{1}'), spell]
          : [lab('PR09 Forge Colored Spell', 'Sorcery', '{R}')]
        : slug === 'genesis-ultimatum'
          ? positive
            ? [
                lab('PR09 Genesis Creature', 'Creature — Beast', '{2}'),
                lab('PR09 Genesis Artifact', 'Artifact', '{2}'),
                spell,
                miss,
                aura,
              ]
            : [miss, miss, miss, miss, miss]
          : slug === 'expressive-iteration'
            ? positive
              ? [spell, miss, aura]
              : [miss, spell]
            : positive
              ? [spell, miss]
              : [miss];
  const basics = ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'].map(basic);
  const setupCards = [
    pin.card,
    ...(slug === 'mystic-forge' ? [pin.card] : []),
    host,
    spell,
    miss,
    ...(positive && slug === 'songbirds-blessing' ? [aura] : []),
    ...libraryCard,
    ...Array.from({ length: 20 }, (_, i) => basics[i % basics.length]!),
  ];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr09-library-${seat}`,
    commanders: [],
    cards:
      slug === 'mystic-forge'
        ? [
            pin.card,
            ...(seat === 'P1' ? [pin.card] : []),
            host,
            spell,
            miss,
            aura,
            ...(seat === 'P1' ? libraryCard : []),
            ...Array.from({ length: 20 }, (_, i) => basics[i % basics.length]!),
          ]
        : slug === 'etali' && !positive
          ? [
              ...(seat === 'P1' ? [pin.card] : []),
              miss,
              ...Array.from({ length: 20 }, (_, i) => basics[i % basics.length]!),
            ]
          : setupCards,
  }));
  const mainCardInHand =
    !forgeActivation &&
    !transform &&
    slug !== 'minds-dilation' &&
    !(slug === 'mystic-forge' && id.endsWith('negative'));
  const hasForge = slug === 'mystic-forge' || forgeActivation;
  const cardCostMana = pin.card.name === 'Expressive Iteration' ? 3 : pin.card.cmc;
  const lands = Array.from(
    { length: Math.max(15, cardCostMana + 2) },
    (_, i) => basics[i % basics.length]!.name,
  );
  const field: Array<{ playerId: 'P1' | 'P2'; cardNames: string[] }> = [
    {
      playerId: 'P1',
      cardNames: [
        ...lands,
        ...(hasForge ? ['Mystic Forge'] : []),
        ...(slug === 'songbirds-blessing' ? [host.name] : []),
        ...(slug === 'minds-dilation' || transform ? [pin.card.name] : []),
      ],
    },
  ];
  const libraryTop: Array<{ playerId: 'P1' | 'P2' | 'P3' | 'P4'; cardNames: string[] }> = [
    { playerId: 'P1', cardNames: libraryCard.map((card) => card.name) },
  ];
  if (slug === 'etali')
    for (const seat of ['P2', 'P3', 'P4'] as const)
      libraryTop.push({
        playerId: seat,
        cardNames: positive ? [miss.name, spell.name] : [miss.name],
      });
  if (slug === 'minds-dilation' && positive)
    libraryTop.push({ playerId: 'P2', cardNames: [spell.name] });
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players, turnCap: slug === 'into-the-time-vortex' ? 10 : 4 },
    {
      preparedScenario: {
        currentTurnPlayer: slug === 'minds-dilation' ? 'P2' : 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: transform ? 2 : 1,
        hand: [
          ...(mainCardInHand
            ? [
                {
                  playerId: 'P1' as const,
                  cardNames: [
                    pin.card.name,
                    ...(slug === 'sunbirds-invocation' ? [spell.name] : []),
                  ],
                },
              ]
            : []),
          ...(slug === 'minds-dilation'
            ? [{ playerId: 'P2' as const, cardNames: [spell.name] }]
            : []),
        ],
        battlefield: [
          ...field,
          ...(slug === 'minds-dilation' ? [{ playerId: 'P2' as const, cardNames: lands }] : []),
        ],
        libraryTop,
        ...(slug === 'songbirds-blessing' ? { continueThroughCombat: true } : {}),
        ...(transform ? { continueThroughCombat: true } : {}),
        ...(slug === 'into-the-time-vortex' ? { continueThroughUpkeeps: 4 } : {}),
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        `Use the normal cast action for ${pin.card.name} and resolve its real trigger or spell effect.`,
        positive
          ? 'Choose the eligible library card when the ability offers a choice.'
          : 'Verify that the ineligible or absent card is not offered.',
      ],
      expectedOutcome: positive
        ? `${pin.card.name} follows its normal cast/ability path with an eligible prepared library card.`
        : `${pin.card.name} resolves with no eligible prepared library card.`,
      oracleSha256: pin.sha256,
      clauseIds: exercisedOracleClauseIndexes(id, slug).map(
        (index) => `pr09-${oracleSlug(pin.card.name)}-clause-${index + 1}`,
      ),
    },
    seed,
    engine,
    seats: players.map((config) => ({
      seat: config.id,
      config,
      deckSnapshotId: null,
      summary: {
        seat: config.id,
        deckId: config.deckId,
        label: config.id,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    })),
  };
}
