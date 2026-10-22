import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import type { Color, GameId, OracleCard } from '@mtg/shared';
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
for (const entry of pins)
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`PR09 Oracle pin drift: ${entry.card.name}`);
const pin = (name: string): Pin => {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR09 Oracle pin ${name}`);
  return found;
};
const basic = (name: string): OracleCard => {
  const found = coverage.find((card) => card.name === name);
  if (!found) throw new Error(`Missing coverage card ${name}`);
  return found;
};
const definitions = [
  ['dark-confidant', 'Dark Confidant'],
  ['dream-pillager', 'Dream Pillager'],
  ['aetherworks-marvel', 'Aetherworks Marvel'],
  ['herald-of-amity', 'Herald of Amity'],
  ['cosmic-cube', 'Cosmic Cube'],
  ['franklin-richards-ascendant', 'Franklin Richards, Ascendant'],
  ['monstrous-vortex', 'Monstrous Vortex'],
  ['chimil-the-inner-sun', 'Chimil, the Inner Sun'],
  ['trumpeting-carnosaur', 'Trumpeting Carnosaur'],
] as const;
type Slug = (typeof definitions)[number][0];
const pinsBySlug = Object.fromEntries(
  definitions.map(([slug, name]) => [slug, pin(name)]),
) as Record<Slug, Pin>;
type Entry = {
  id: string;
  title: string;
  cardName: string;
  slug: Slug;
  kind: 'positive' | 'negative' | 'activation' | 'attack' | 'discard';
};
const entries: Entry[] = definitions.flatMap(([slug, cardName]) => [
  {
    id: `pr09-${slug}-viewer-positive`,
    title: `${cardName}: resolve the prepared ability`,
    cardName,
    slug,
    kind: 'positive' as const,
  },
  {
    id: `pr09-${slug}-viewer-negative`,
    title: `${cardName}: verify the contrasting prepared state`,
    cardName,
    slug,
    kind: 'negative' as const,
  },
]);
entries.push(
  {
    id: 'pr09-aetherworks-marvel-viewer-activation',
    title: 'Aetherworks Marvel: activate with six energy',
    cardName: 'Aetherworks Marvel',
    slug: 'aetherworks-marvel',
    kind: 'activation',
  },
  {
    id: 'pr09-herald-of-amity-viewer-attack',
    title: 'Herald of Amity: attack and count controlled Auras',
    cardName: 'Herald of Amity',
    slug: 'herald-of-amity',
    kind: 'attack',
  },
  {
    id: 'pr09-trumpeting-carnosaur-viewer-discard',
    title: 'Trumpeting Carnosaur: pay the discard damage ability',
    cardName: 'Trumpeting Carnosaur',
    slug: 'trumpeting-carnosaur',
    kind: 'discard',
  },
);
export const PR09_PERMANENT_SCENARIOS = entries.map(({ id, title, cardName }) => ({
  id,
  title,
  cardName,
}));

const lab = (
  name: string,
  typeLine: string,
  manaCost: string | null = '{1}',
  oracleText = '',
  power: string | null = null,
): OracleCard => {
  const base = coverage.find((card) => card.name === 'Forest');
  if (!base) throw new Error('Missing Forest from coverage Oracle');
  const [left, right] = typeLine.split(' — ');
  const types = (left ?? '')
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
  const subtypes = right?.split(' ') ?? [];
  const cmc =
    manaCost === null
      ? 0
      : (manaCost.match(/\{\d+\}/g) ?? []).reduce(
          (sum, token) => sum + Number(token.slice(1, -1)),
          0,
        ) + (manaCost.match(/\{[WUBRG]\}/g)?.length ?? 0);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const colors = [
    ...new Set((manaCost?.match(/\{([WUBRG])\}/g) ?? []).map((token) => token[1] as Color)),
  ];
  return {
    ...base,
    oracleId: `lab-pr09-permanent-${slug}`,
    scryfallId: `lab-pr09-permanent-${slug}`,
    name,
    manaCost,
    cmc,
    colors,
    colorIdentity: colors,
    typeLine,
    types,
    supertypes: [],
    subtypes,
    oracleText,
    power,
    toughness: power === null ? null : '2',
    keywords: [],
    isBasicLand: types.includes('Land'),
  };
};
const host = lab('PR09 Viewer Host', 'Creature — Human', '{2}', '', '2');
const aura = lab('PR09 Viewer Aura', 'Enchantment — Aura', '{1}{W}', 'Enchant creature');
const spell = lab('PR09 Viewer Spell', 'Sorcery', '{U}', 'You gain 1 life.');
const discoverHit = lab('PR09 Viewer Discover Hit', 'Sorcery', '{R}', 'You gain 1 life.');
const creature = lab('PR09 Viewer Creature', 'Creature — Beast', '{4}{G}{G}', '', '7');
const miss = lab('PR09 Viewer Miss', 'Land', null);
const auraCreature = lab('PR09 Aura Creature', 'Creature — Aura', '{2}', '', '2');
const sacrificeArtifact = lab('PR09 Viewer Sacrifice Artifact', 'Artifact', '{0}');
const artifactRemoval = lab(
  'PR09 Viewer Artifact Removal',
  'Instant',
  '{1}',
  'Destroy target artifact.',
);
const viewerInstant = lab('PR09 Viewer Instant', 'Instant', '{U}', 'You gain 1 life.');
const viewerCounter = lab('PR09 Viewer Counter', 'Instant', '{U}', 'Counter target spell.');
const clauseIds = (slug: Slug, kind: Entry['kind']): string[] => {
  const p = `pr09-${slug}-clause-`;
  if (slug === 'dream-pillager') return [p + '1', p + '2'];
  if (slug === 'aetherworks-marvel') return kind === 'positive' ? [p + '1', p + '2'] : [p + '2'];
  if (slug === 'cosmic-cube') return [p + '1', p + '2'];
  if (slug === 'herald-of-amity')
    return kind === 'attack' ? [p + '1', p + '3'] : [p + '1', p + '2'];
  if (slug === 'chimil-the-inner-sun') return kind === 'positive' ? [p + '1', p + '2'] : [p + '1'];
  if (slug === 'trumpeting-carnosaur')
    return [p + (kind === 'discard' ? '3' : '1'), ...(kind === 'discard' ? [] : [p + '2'])];
  return [p + '1'];
};

/** Build a source-pinned prepared viewer scenario for a remaining PR09 permanent. */
export function pr09PermanentScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown PR09 permanent scenario ${id}`);
  const source = pinsBySlug[entry.slug];
  const positive = entry.kind !== 'negative';
  const hand = new Set<Slug>(['herald-of-amity', 'trumpeting-carnosaur']);
  if (entry.slug === 'trumpeting-carnosaur' && entry.kind === 'discard') hand.add(entry.slug);
  const battlefield: Array<{
    playerId: 'P1' | 'P2';
    cardNames: string[];
    counters?: Record<string, number>;
    attachedToCard?: { playerId: 'P1' | 'P2'; cardName: string };
  }> = [];
  const p1: string[] = [];
  const permanentSource = new Set<Slug>([
    'aetherworks-marvel',
    'cosmic-cube',
    'franklin-richards-ascendant',
    'monstrous-vortex',
    'chimil-the-inner-sun',
  ]);
  if (
    permanentSource.has(entry.slug) ||
    entry.slug === 'dark-confidant' ||
    entry.slug === 'dream-pillager'
  )
    p1.push(source.card.name);
  if (entry.slug === 'dark-confidant' || entry.slug === 'dream-pillager') p1.push(source.card.name);
  if (entry.slug === 'herald-of-amity' && entry.kind === 'attack') p1.push(source.card.name);
  if (entry.slug === 'herald-of-amity' && entry.kind === 'attack') p1.push(host.name, aura.name);
  else if (entry.slug === 'herald-of-amity') p1.push(host.name);
  else if (entry.kind === 'attack') p1.push(host.name, aura.name);
  if (entry.slug === 'cosmic-cube') p1.push(creature.name);
  if (entry.slug === 'aetherworks-marvel' && entry.kind === 'positive')
    p1.push(sacrificeArtifact.name);
  const manaLands = [
    'Forest',
    'Mountain',
    'Island',
    'Plains',
    'Swamp',
    'Forest',
    'Mountain',
    'Swamp',
    'Island',
  ].map(basic);
  const p1Permanents = [...new Set(p1)];
  if (entry.kind === 'attack' && entry.slug === 'herald-of-amity') {
    battlefield.push({
      playerId: 'P1',
      cardNames: [
        ...manaLands.map((card) => card.name),
        ...p1Permanents.filter((name) => name !== aura.name),
      ],
    });
    battlefield.push({
      playerId: 'P1',
      cardNames: [aura.name],
      attachedToCard: { playerId: 'P1', cardName: host.name },
    });
  } else {
    battlefield.push({
      playerId: 'P1',
      cardNames: [...manaLands.map((card) => card.name), ...p1Permanents],
      ...(entry.kind === 'activation' ? { counters: { energy: 6 } } : {}),
    });
  }
  if (entry.kind === 'discard') battlefield.push({ playerId: 'P2', cardNames: [creature.name] });
  if (entry.slug === 'cosmic-cube')
    battlefield.push({ playerId: 'P2', cardNames: [source.card.name] });
  const extra = Array.from(
    { length: 7 },
    (_, i) => lab(`PR09 filler ${i}`, 'Sorcery', '{1}', 'You gain 1 life.').name,
  );
  const barren = ['Forest', 'Mountain', 'Island', 'Plains', 'Swamp', 'Forest'].map(
    (name) => basic(name).name,
  );
  let top = [spell.name, miss.name, ...extra];
  if (entry.slug === 'aetherworks-marvel' && entry.kind === 'negative') top = [miss.name, ...extra];
  if (entry.slug === 'dark-confidant') top = positive ? [spell.name] : [];
  if (entry.slug === 'dream-pillager')
    top = positive ? [spell.name, miss.name, ...extra] : [miss.name];
  if (entry.slug === 'herald-of-amity' && entry.kind !== 'attack')
    top = positive
      ? [aura.name, ...extra]
      : [auraCreature.name, spell.name, miss.name, ...extra.slice(0, 5)];
  if (entry.slug === 'cosmic-cube') top = positive ? [spell.name, ...extra.slice(0, 5)] : barren;
  if (entry.slug === 'franklin-richards-ascendant')
    top = positive ? [discoverHit.name, miss.name, ...extra] : barren;
  if (
    entry.slug === 'chimil-the-inner-sun' ||
    entry.slug === 'monstrous-vortex' ||
    entry.slug === 'trumpeting-carnosaur'
  )
    top = positive ? [spell.name, miss.name, ...extra] : barren;
  const libraryTop = top.length ? [{ playerId: 'P1' as const, cardNames: top }] : [];
  const setup = [
    source.card,
    host,
    aura,
    spell,
    discoverHit,
    creature,
    miss,
    auraCreature,
    sacrificeArtifact,
    artifactRemoval,
    viewerInstant,
    viewerCounter,
    ...extra.map((name) => lab(name, 'Sorcery', '{1}', 'You gain 1 life.')),
    ...['Forest', 'Mountain', 'Island', 'Plains', 'Swamp'].map(basic),
  ];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr09-permanent-${seat}`,
    commanders: [],
    cards: [
      ...setup,
      ...Array.from({ length: 20 }, (_, i) =>
        basic(['Forest', 'Mountain', 'Island', 'Plains', 'Swamp'][i % 5]!),
      ),
    ],
  }));
  const combat =
    ['dream-pillager', 'herald-of-amity', 'cosmic-cube', 'franklin-richards-ascendant'].includes(
      entry.slug,
    ) || entry.kind === 'attack';
  let handCards = hand.has(entry.slug) && !p1.includes(source.card.name) ? [source.card.name] : [];
  if (entry.slug === 'franklin-richards-ascendant') handCards = [spell.name];
  if (entry.slug === 'monstrous-vortex') handCards = [creature.name];
  if (entry.slug === 'aetherworks-marvel' && entry.kind === 'negative') handCards = [spell.name];
  if (entry.slug === 'aetherworks-marvel' && entry.kind === 'positive')
    handCards = [artifactRemoval.name];
  if (entry.slug === 'chimil-the-inner-sun') handCards = [viewerInstant.name, viewerCounter.name];
  if (entry.slug === 'cosmic-cube') handCards = [artifactRemoval.name];
  const engine = new Engine(
    { gameId, seed: `card-lab-${id}-v1`, players, turnCap: 10 },
    {
      preparedScenario: {
        currentTurnPlayer: entry.slug === 'dark-confidant' ? 'P4' : 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: handCards }],
        battlefield,
        ...(libraryTop.length ? { libraryTop } : {}),
        ...(entry.slug === 'aetherworks-marvel' && entry.kind !== 'negative'
          ? { energy: [{ playerId: 'P1', amount: entry.kind === 'positive' ? 5 : 6 }] }
          : {}),
        ...(entry.slug === 'dark-confidant' ? { continueThroughUpkeeps: 1 } : {}),
        ...(combat ? { continueThroughCombat: true } : {}),
        ...(entry.slug === 'dream-pillager' ? { continueToPostcombatMain: true } : {}),
        ...(entry.slug === 'chimil-the-inner-sun' ? { continueToEndStep: true } : {}),
      },
    },
  );
  if (entry.slug === 'dark-confidant' && entry.kind === 'negative') {
    const owner = engine.getState().players.find((player) => player.id === 'P1');
    if (!owner) throw new Error('Missing P1 for Dark Confidant empty-library scenario');
    owner.library.length = 0;
  }
  if (
    entry.kind === 'negative' &&
    [
      'dream-pillager',
      'cosmic-cube',
      'franklin-richards-ascendant',
      'monstrous-vortex',
      'chimil-the-inner-sun',
      'trumpeting-carnosaur',
    ].includes(entry.slug)
  ) {
    const owner = engine.getState().players.find((player) => player.id === 'P1');
    if (!owner) throw new Error(`Missing P1 for ${entry.cardName} negative scenario`);
    owner.library = owner.library.filter((card) => card.typeLine.includes('Land'));
  }
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        `Use the normal cast or activation path for ${entry.cardName}.`,
        positive
          ? 'Resolve the prepared trigger and verify the resulting authoritative game state.'
          : 'Verify the ineligible or absent outcome from the authoritative game state.',
      ],
      expectedOutcome: `${entry.cardName} follows its production ${entry.kind} flow in the prepared game.`,
      oracleSha256: source.sha256,
      clauseIds: clauseIds(entry.slug, entry.kind),
    },
    seed: `card-lab-${id}-v1`,
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
