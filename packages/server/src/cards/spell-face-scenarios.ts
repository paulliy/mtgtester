import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Engine } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';
import { SPELL_FACE_LAB_EXPECTATIONS } from './spell-face-lab-expectations';

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/selected-spell-faces-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];
const lands = ['Forest', 'Island', 'Plains', 'Mountain', 'Swamp'].map((name) => {
  const card = coverage.find((entry) => entry.name === name);
  if (!card) throw new Error(`Missing spell-face lab basic land ${name}`);
  return card;
});
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
const cases = SPELL_FACE_LAB_EXPECTATIONS.flatMap((expected) => {
  const pin = pins.cards.find(({ card }) => card.name.split(' // ')[0] === expected.name);
  if (
    !pin?.card.backFace ||
    createHash('sha256').update(JSON.stringify(pin.card)).digest('hex') !== pin.sha256
  )
    throw new Error(`Spell-face Oracle fixture drift: ${expected.name}`);
  return (
    expected.name === 'Glóin the Mighty'
      ? (['front', 'half', 'commander'] as const)
      : expected.name === 'Foulmire Knight' || expected.name === 'Sagu Wildling'
        ? (['front', 'half', 'impulse'] as const)
        : (['front', 'half'] as const)
  ).map((mode) => ({
    ...pin,
    expected,
    mode,
    id:
      mode === 'impulse'
        ? `${slug(pin.card.backFace!.name)}-viewer-impulse-face`
        : mode === 'commander'
          ? 'easy-pickings-viewer-commander-face'
          : mode === 'half'
            ? `${slug(pin.card.backFace!.name)}-viewer-normal-face`
            : `${slug(expected.name)}-viewer-front`,
    title:
      mode === 'impulse'
        ? `${pin.card.backFace!.name}: cast the spell face from temporary exile`
        : mode === 'commander'
          ? 'Easy Pickings: cast an Adventure commander from the command zone'
          : mode === 'half'
            ? `${pin.card.backFace!.name}: cast the selected spell face`
            : `${expected.name}: play the ordinary front`,
  }));
});
export const SPELL_FACE_SCENARIO_IDS = cases.map(({ id }) => id);

function witness(name: string, typeLine: string, text = ''): OracleCard {
  const creature = typeLine.startsWith('Creature');
  return {
    ...lands[0]!,
    oracleId: `lab-${slug(name)}`,
    scryfallId: `lab-${slug(name)}`,
    name,
    typeLine,
    types: [creature ? 'Creature' : typeLine],
    subtypes: creature ? [typeLine.split(' — ')[1]!] : [],
    supertypes: [],
    isBasicLand: false,
    manaCost: '{0}',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    keywords: [],
    oracleText: text,
    power: creature ? (name.includes('Giant') ? '3' : '2') : null,
    toughness: creature ? (name.includes('Giant') ? '3' : '2') : null,
  };
}
export function spellFaceScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = cases.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown spell-face scenario ${id}`);
  const own = witness('Own Face Bear', 'Creature — Bear');
  const other = witness('Chosen Face Bear', 'Creature — Bear');
  const artifact = witness('Chosen Face Artifact', 'Artifact');
  const giant = witness('Face Giant Witness', 'Creature — Giant');
  const response = witness('Independent Commander Response', 'Instant', 'You gain 1 life.');
  const impulse = witness(
    'Independent Impulse Permission',
    'Instant',
    'Choose one —\n• Exile the top one card of your library. You may play it this turn.',
  );
  const mana = [...lands, ...lands];
  const library = entry.expected.search
    ? [...lands]
    : ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label) => ({
        ...witness(`Face Library ${label}`, 'Instant', 'You gain 1 life.'),
        manaCost: '{99}',
        cmc: 99,
      }));
  const seed = `card-lab-${id}-v1`;
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `spell-face-lab-${seat}`,
    commanders: seat === 'P1' && entry.mode === 'commander' ? [entry.card] : [],
    cards:
      seat === 'P1'
        ? [
            ...(entry.mode === 'commander'
              ? [response]
              : entry.mode === 'impulse'
                ? [entry.card, impulse, response]
                : [entry.card]),
            own,
            giant,
            ...mana,
            ...library,
          ]
        : seat === 'P2'
          ? [other, artifact, ...lands]
          : [...lands],
  }));
  return {
    metadata: {
      id,
      version: entry.mode === 'impulse' ? 2 : 1,
      title: entry.title,
      instructions: [
        ...(entry.mode === 'impulse'
          ? ['Cast Independent Impulse Permission, pass, then choose the exiled spell face.']
          : []),
        `Play ${entry.mode !== 'front' ? entry.card.backFace!.name : entry.expected.name} through the normal controls.`,
        'Choose the indicated witness, complete printed choices, then pass to finish.',
      ],
      expectedOutcome:
        entry.mode !== 'front'
          ? 'The printed spell face resolves with its own cost and characteristics, then uses Adventure exile or Omen shuffle.'
          : 'The ordinary front enters with its printed characteristics and entry effects.',
      oracleSha256: entry.sha256,
      clauseIds: [`${slug(entry.card.backFace!.name)}-${entry.mode}`],
    },
    seed,
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
    engine: new Engine(
      { gameId, seed, players, turnCap: 2 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [
            {
              playerId: 'P1',
              cardNames:
                entry.mode === 'impulse'
                  ? [impulse.name, response.name]
                  : [entry.mode === 'commander' ? response.name : entry.card.name],
            },
          ],
          battlefield: [
            { playerId: 'P1', cardNames: [...mana.map((card) => card.name), own.name, giant.name] },
            { playerId: 'P2', cardNames: [other.name], tapped: entry.expected.untap ?? false },
            { playerId: 'P2', cardNames: [artifact.name] },
          ],
          ...(entry.mode === 'impulse'
            ? { libraryTop: [{ playerId: 'P1' as const, cardNames: [entry.card.name] }] }
            : {}),
        },
      },
    ),
  };
}
