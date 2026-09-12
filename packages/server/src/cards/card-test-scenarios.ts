import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig } from '@mtg/engine';
import type { CardTestScenarioMetadata, Color, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { SeatSetup } from '../match/setup';

export interface CardTestScenario {
  metadata: CardTestScenarioMetadata;
  seed: string;
  seats: SeatSetup[];
  engine: Engine;
}

interface CardInput {
  oracleId: string;
  name: string;
  typeLine: string;
  manaCost?: string | null;
  oracleText?: string;
  cmc?: number;
  colors?: Color[];
  colorIdentity?: Color[];
  power?: string | null;
  toughness?: string | null;
}

function card(input: CardInput): OracleCard {
  const [left, subtypeText] = input.typeLine.split(/\s+—\s+/, 2);
  const words = (left ?? '').split(/\s+/);
  const knownTypes = new Set([
    'Artifact',
    'Battle',
    'Creature',
    'Enchantment',
    'Instant',
    'Land',
    'Planeswalker',
    'Sorcery',
  ]);
  return {
    oracleId: input.oracleId,
    scryfallId: `lab-${input.oracleId}`,
    name: input.name,
    manaCost: (input.manaCost ?? null) as OracleCard['manaCost'],
    cmc: input.cmc ?? 0,
    colors: input.colors ?? [],
    colorIdentity: input.colorIdentity ?? input.colors ?? [],
    typeLine: input.typeLine,
    supertypes: words.filter((word) => ['Basic', 'Legendary', 'Snow'].includes(word)),
    types: words.filter((word) => knownTypes.has(word)),
    subtypes: subtypeText?.split(/\s+/).filter(Boolean) ?? [],
    oracleText: input.oracleText ?? '',
    power: input.power ?? null,
    toughness: input.toughness ?? null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: words.includes('Basic') && words.includes('Land'),
  };
}

/**
 * The real reviewed cards come from the pinned Oracle fixtures (plan step 2) rather than
 * hand-copied data, so the lab exercises exactly what the engine regressions pin.
 */
interface PinnedOracleFile {
  cards: Array<{ sha256: string; card: OracleCard }>;
}

const PINNED: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedOracleFile;

const QUEEN_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/queen-engine-batch2-oracle.json'), 'utf8'),
) as PinnedOracleFile;

const NECRON_MAIN_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/necron-main-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const DRACONIC_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/draconic-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const SILVERQUILL_MAIN_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/silverquill-main-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const TOKEN_TRIUMPH_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/token-triumph-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const TOKEN_TRIUMPH_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/token-triumph-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const TOKEN_TRIUMPH_BATCH3: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/token-triumph-engine-batch3-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const NECRON_REMAINING_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/necron-remaining-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const SILVERQUILL_REMAINING_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/silverquill-remaining-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const DRACONIC_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/draconic-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const NECRON_MAIN_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/necron-main-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

function pinnedFrom(file: PinnedOracleFile, name: string): { card: OracleCard; sha256: string } {
  const entry = file.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`No pinned Oracle fixture for ${name}`);
  return entry;
}

function pinnedCard(name: string): OracleCard {
  return pinnedFrom(PINNED, name).card;
}

function pinnedSha256(name: string): string {
  return pinnedFrom(PINNED, name).sha256;
}

const TRIBUTE_MAGE = card({
  oracleId: 'c2b51295-8820-425f-a517-55231123c7de',
  name: 'Tribute Mage',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{2}{U}',
  cmc: 3,
  colors: ['U'],
  colorIdentity: ['U'],
  power: '2',
  toughness: '2',
  oracleText:
    'When this creature enters, you may search your library for an artifact card with mana value 2, reveal that card, put it into your hand, then shuffle.',
});
const ISLAND = card({
  oracleId: 'lab-island',
  name: 'Island',
  typeLine: 'Basic Land — Island',
});
const FOREST = card({
  oracleId: 'lab-forest',
  name: 'Forest',
  typeLine: 'Basic Land — Forest',
});
const ELIGIBLE = card({
  oracleId: 'lab-eligible-talisman',
  name: 'Eligible Talisman',
  typeLine: 'Artifact',
  manaCost: '{2}',
  cmc: 2,
});
const ELIGIBLE_SIGNET = card({
  oracleId: 'lab-eligible-signet',
  name: 'Eligible Signet',
  typeLine: 'Artifact',
  manaCost: '{1}{U}',
  cmc: 2,
  colors: ['U'],
  colorIdentity: ['U'],
});
const WRONG_MV = card({
  oracleId: 'lab-wrong-mv-artifact',
  name: 'Wrong-MV Artifact',
  typeLine: 'Artifact',
  manaCost: '{3}',
  cmc: 3,
});
const WRONG_TYPE = card({
  oracleId: 'lab-two-mana-bear',
  name: 'Two-Mana Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{2}',
  cmc: 2,
  power: '2',
  toughness: '2',
});
const SWAMP = card({
  oracleId: 'lab-swamp',
  name: 'Swamp',
  typeLine: 'Basic Land — Swamp',
});
const PLAINS = card({
  oracleId: 'lab-plains',
  name: 'Plains',
  typeLine: 'Basic Land — Plains',
});
const MOUNTAIN = card({
  oracleId: 'lab-mountain',
  name: 'Mountain',
  typeLine: 'Basic Land — Mountain',
});
/** Fully interpreter-modeled lab spells keep the interaction under test on normal engine paths. */
const LAB_SHOCK = card({
  oracleId: 'lab-shock',
  name: 'Lab Shock',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  colors: ['R'],
  colorIdentity: ['R'],
  oracleText: 'Lab Shock deals 2 damage to any target.',
});
const LAB_DOOM = card({
  oracleId: 'lab-doom',
  name: 'Lab Doom',
  typeLine: 'Instant',
  manaCost: '{1}{B}',
  cmc: 2,
  colors: ['B'],
  colorIdentity: ['B'],
  oracleText: 'Destroy target creature.',
});
const LAB_SHAMAN = card({
  oracleId: 'lab-shaman',
  name: 'Lab Shaman',
  typeLine: 'Creature — Shaman',
  manaCost: '{1}{R}',
  cmc: 2,
  colors: ['R'],
  colorIdentity: ['R'],
  power: '2',
  toughness: '2',
  oracleText: 'When this creature enters, you gain 1 life.',
});
const GRAVE_PICKER = card({
  oracleId: 'lab-grave-picker',
  name: 'Grave Picker',
  typeLine: 'Creature — Goblin',
  manaCost: '{1}{B}',
  cmc: 2,
  colors: ['B'],
  colorIdentity: ['B'],
  power: '1',
  toughness: '1',
  oracleText: '{1}, {T}: Return target artifact card from your graveyard to your hand.',
});

function player(
  id: PlayerId,
  cards: OracleCard[],
): { config: EnginePlayerConfig; setup: SeatSetup } {
  const config: EnginePlayerConfig = {
    id,
    deckId: `card-lab-${id}`,
    commanders: [],
    cards,
  };
  return {
    config,
    setup: {
      seat: id,
      config,
      summary: {
        seat: id,
        deckId: config.deckId,
        label: id === 'P1' ? 'Card Test Lab' : `Deterministic opponent ${id}`,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
      deckSnapshotId: null,
    },
  };
}

function tributeMageScenario(gameId: GameId): CardTestScenario {
  const p1 = player('P1', [
    TRIBUTE_MAGE,
    ISLAND,
    FOREST,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
    WRONG_TYPE,
    FOREST,
  ]);
  const opponents = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...opponents.map(({ setup }) => setup)];
  const seed = 'card-lab-tribute-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...opponents.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Tribute Mage'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'tribute-viewer-cast-search-select-resolve',
      version: 1,
      title: 'Tribute Mage: exact mana-value search',
      instructions: [
        'Cast Tribute Mage from your hand using the three untapped lands.',
        'Pass priority so Tribute Mage resolves.',
        'Choose Eligible Talisman from the two valid enter-the-battlefield search results.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Only the two mana-value-2 artifacts are offered; Eligible Talisman moves to your hand and the library is shuffled.',
      oracleSha256: '8e7a10c283be40e58a317e2e269067277f9a9f8563c2f557422b9ee72eadf9d2',
      clauseIds: ['tribute-mage-search-mv2'],
    },
    seed,
    seats,
    engine,
  };
}

/** The deterministic opponent controlling Gev makes the ward pay/decline decision. */
function gevWardScenario(gameId: GameId): CardTestScenario {
  const gev = pinnedCard('Gev, Scaled Scorch');
  const p1 = player('P1', [LAB_DOOM, SWAMP, SWAMP, FOREST, FOREST]);
  const p2 = player('P2', [gev, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-gev-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Swamp'] },
          { playerId: 'P2', cardNames: ['Gev, Scaled Scorch'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'gev-viewer-opponent-targets-ward',
      version: 1,
      title: 'Gev, Scaled Scorch: ward — pay 2 life',
      instructions: [
        'Cast Lab Doom targeting the opponent\u2019s Gev, Scaled Scorch.',
        'Watch Gev\u2019s ward trigger go on the stack demanding a 2-life payment.',
        'Pass priority until the stack is empty; the ward controller decides whether to pay.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'The ward trigger fires when the opponent\u2019s spell targets Gev; if 2 life is not paid the spell is countered and Gev survives, otherwise Gev is destroyed and the controller loses 2 life.',
      oracleSha256: pinnedSha256('Gev, Scaled Scorch'),
      clauseIds: ['gev-ward-life-payment'],
    },
    seed,
    seats,
    engine,
  };
}

function nightscapeScenario(gameId: GameId): CardTestScenario {
  const familiar = pinnedCard('Nightscape Familiar');
  const p1 = player('P1', [familiar, LAB_DOOM, SWAMP, SWAMP, SWAMP, SWAMP, FOREST]);
  const opponents = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...opponents.map(({ setup }) => setup)];
  const seed = 'card-lab-nightscape-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...opponents.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Nightscape Familiar', 'Swamp', 'Swamp', 'Swamp', 'Swamp'],
          },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'nightscape-viewer-activate-regenerate-destroy',
      version: 1,
      title: 'Nightscape Familiar: regenerate survives destruction',
      instructions: [
        'Activate Nightscape Familiar\u2019s {1}{B} regenerate ability and let it resolve.',
        'Cast Lab Doom targeting your own Nightscape Familiar.',
        'Pass priority so Lab Doom resolves into the regeneration shield.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'The destruction is replaced: Nightscape Familiar stays on the battlefield, becomes tapped, and the used-up shield is gone.',
      oracleSha256: pinnedSha256('Nightscape Familiar'),
      clauseIds: ['nightscape-regenerate-activated'],
    },
    seed,
    seats,
    engine,
  };
}

function thranVigilScenario(gameId: GameId): CardTestScenario {
  const vigil = pinnedCard('Thran Vigil');
  const p1 = player('P1', [vigil, GRAVE_PICKER, SWAMP, ELIGIBLE, FOREST, FOREST]);
  const opponents = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...opponents.map(({ setup }) => setup)];
  const seed = 'card-lab-thran-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...opponents.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [{ playerId: 'P1', cardNames: ['Thran Vigil', 'Grave Picker', 'Swamp'] }],
        graveyard: [{ playerId: 'P1', cardNames: ['Eligible Talisman'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'thran-viewer-graveyard-departure-trigger',
      version: 1,
      title: 'Thran Vigil: artifact leaves your graveyard',
      instructions: [
        'Activate Grave Picker\u2019s ability, targeting Eligible Talisman in your graveyard.',
        'Pass priority so the ability resolves and the artifact leaves your graveyard on your turn.',
        'Thran Vigil triggers; choose Grave Picker as the creature that gets the counter.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Eligible Talisman returns to your hand, Thran Vigil triggers once for the departure, and Grave Picker gets a +1/+1 counter.',
      oracleSha256: pinnedSha256('Thran Vigil'),
      clauseIds: ['thran-vigil-graveyard-departure'],
    },
    seed,
    seats,
    engine,
  };
}

function harmonicProdigyScenario(gameId: GameId): CardTestScenario {
  const prodigy = pinnedCard('Harmonic Prodigy');
  const p1 = player('P1', [prodigy, LAB_SHAMAN, MOUNTAIN, MOUNTAIN, FOREST, FOREST]);
  const opponents = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...opponents.map(({ setup }) => setup)];
  const seed = 'card-lab-harmonic-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...opponents.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Shaman'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Harmonic Prodigy', 'Mountain', 'Mountain'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'harmonic-viewer-cast-and-double-trigger',
      version: 1,
      title: 'Harmonic Prodigy: Shaman trigger fires twice',
      instructions: [
        'Cast Lab Shaman using the two untapped Mountains.',
        'Pass priority so Lab Shaman resolves.',
        'Watch its enter-the-battlefield trigger go on the stack twice, then pass to resolve both.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Shaman\u2019s gain-life trigger appears on the stack exactly twice because Harmonic Prodigy adds one trigger, and you gain 2 life.',
      oracleSha256: pinnedSha256('Harmonic Prodigy'),
      clauseIds: ['harmonic-prodigy-additional-trigger'],
    },
    seed,
    seats,
    engine,
  };
}

const LAB_OX = card({
  oracleId: 'lab-ox',
  name: 'Lab Ox',
  typeLine: 'Creature — Ox',
  manaCost: '{4}',
  cmc: 4,
  power: '4',
  toughness: '4',
});
const LAB_SERVO = card({
  oracleId: 'lab-servo',
  name: 'Lab Servo',
  typeLine: 'Artifact Creature — Servo',
  manaCost: '{1}',
  cmc: 1,
  power: '1',
  toughness: '1',
});
const LAB_HEX = card({
  oracleId: 'lab-hex',
  name: 'Lab Hex',
  typeLine: 'Enchantment',
  manaCost: '{2}{W}',
  cmc: 3,
  colors: ['W'],
  colorIdentity: ['W'],
});
const LAB_BIRD = card({
  oracleId: 'lab-bird',
  name: 'Lab Bird',
  typeLine: 'Creature — Bird',
  manaCost: '{W}',
  cmc: 1,
  colors: ['W'],
  colorIdentity: ['W'],
  power: '1',
  toughness: '1',
  oracleText: 'Flying',
});

function swordsScenario(gameId: GameId): CardTestScenario {
  const swords = pinnedFrom(QUEEN_BATCH2, 'Swords to Plowshares');
  const p1 = player('P1', [swords.card, PLAINS, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-swords-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Swords to Plowshares'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'swords-viewer-exile-and-gain-life',
      version: 1,
      title: 'Swords to Plowshares: exile and gain life',
      instructions: [
        'Cast Swords to Plowshares from your hand using the untapped Plains.',
        'Target the opponent\u2019s Lab Ox.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is exiled, not sent to the graveyard, and its controller gains life equal to its power.',
      oracleSha256: swords.sha256,
      clauseIds: ['swords-exiles-and-gains-life-equal-to-power'],
    },
    seed,
    seats,
    engine,
  };
}

function throatScenario(gameId: GameId): CardTestScenario {
  const throat = pinnedFrom(NECRON_MAIN_BATCH1, 'Go for the Throat');
  const p1 = player('P1', [throat.card, SWAMP, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-throat-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Go for the Throat'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'throat-viewer-destroy-nonartifact',
      version: 1,
      title: 'Go for the Throat: destroy a nonartifact creature',
      instructions: [
        'Cast Go for the Throat from your hand using the untapped Swamp and Forest.',
        'Target the opponent\u2019s Lab Ox. Lab Servo is an artifact creature and must not be a legal target.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is destroyed. Lab Servo remains because artifact creatures are illegal targets.',
      oracleSha256: throat.sha256,
      clauseIds: ['throat-destroys-a-nonartifact-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function blossomingScenario(gameId: GameId): CardTestScenario {
  const defense = pinnedFrom(DRACONIC_BATCH1, 'Blossoming Defense');
  const p1 = player('P1', [defense.card, FOREST, LAB_OX, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-blossoming-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Blossoming Defense'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Lab Ox'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'defense-viewer-pump-and-hexproof',
      version: 1,
      title: 'Blossoming Defense: pump and hexproof',
      instructions: [
        'Cast Blossoming Defense from your hand using the untapped Forest.',
        'Target your Lab Ox. An opponent\u2019s creature would be an illegal target.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox gets +2/+2 and hexproof until end of turn, becoming a 6/6.',
      oracleSha256: defense.sha256,
      clauseIds: ['defense-pumps-and-grants-hexproof-to-your-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function bogScenario(gameId: GameId): CardTestScenario {
  const bog = pinnedFrom(SILVERQUILL_MAIN_BATCH1, 'Bojuka Bog');
  const p1 = player('P1', [bog.card, LAB_SERVO, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-bog-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Bojuka Bog'] }],
        battlefield: [],
        graveyard: [
          { playerId: 'P1', cardNames: ['Lab Servo'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'bog-viewer-exile-targeted-graveyard',
      version: 1,
      title: 'Bojuka Bog: exile the targeted graveyard',
      instructions: [
        'Play Bojuka Bog from your hand. It enters tapped.',
        'Target opponent P2 with the enter-the-battlefield ability.',
        'Pass priority so the ability resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        "P2's Lab Ox is exiled. Your Lab Servo stays in your graveyard because it was not the targeted player.",
      oracleSha256: bog.sha256,
      clauseIds: ['bog-enters-tapped-and-exiles-the-targeted-graveyard'],
    },
    seed,
    seats,
    engine,
  };
}

function bustScenario(gameId: GameId): CardTestScenario {
  const bust = pinnedFrom(TOKEN_TRIUMPH_BATCH1, 'Citywide Bust');
  const p1 = player('P1', [bust.card, PLAINS, PLAINS, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-bust-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Citywide Bust'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains', 'Plains', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'bust-viewer-destroy-toughness-four-or-greater',
      version: 1,
      title: 'Citywide Bust: destroy toughness 4 or greater',
      instructions: [
        'Cast Citywide Bust from your hand using the two Plains and the Forest.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox (toughness 4) is destroyed. Lab Servo (toughness 1) remains.',
      oracleSha256: bust.sha256,
      clauseIds: ['bust-destroys-toughness-4-or-greater-and-spares-smaller'],
    },
    seed,
    seats,
    engine,
  };
}

function defileScenario(gameId: GameId): CardTestScenario {
  const defile = pinnedFrom(NECRON_MAIN_BATCH1, 'Defile');
  const p1 = player('P1', [defile.card, SWAMP, SWAMP, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-defile-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Defile'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Swamp'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'defile-viewer-minus-one-per-swamp',
      version: 1,
      title: 'Defile: -1/-1 per Swamp you control',
      instructions: [
        'Cast Defile from your hand using one untapped Swamp.',
        'Target the opponent\u2019s Lab Ox. You still control two Swamps after paying.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox gets -2/-2 until end of turn, becoming a 2/2. Lab Servo is untargeted and stays 1/1. Opponent Swamps would not count.',
      oracleSha256: defile.sha256,
      clauseIds: ['defile-minus-one-per-your-swamp'],
    },
    seed,
    seats,
    engine,
  };
}

function furyScenario(gameId: GameId): CardTestScenario {
  const fury = pinnedFrom(DRACONIC_BATCH1, 'Unleash Fury');
  const p1 = player('P1', [fury.card, MOUNTAIN, FOREST, LAB_OX]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-fury-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Unleash Fury'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Mountain', 'Forest', 'Lab Ox'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'fury-viewer-double-power',
      version: 1,
      title: 'Unleash Fury: double target power',
      instructions: [
        'Cast Unleash Fury from your hand using the untapped Mountain and Forest.',
        'Target your Lab Ox.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome: 'Lab Ox\u2019s power doubles until end of turn, becoming an 8/4.',
      oracleSha256: fury.sha256,
      clauseIds: ['fury-doubles-target-power-until-end-of-turn'],
    },
    seed,
    seats,
    engine,
  };
}

function mutationScenario(gameId: GameId): CardTestScenario {
  const mutation = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Aura Mutation');
  const p1 = player('P1', [mutation.card, FOREST, PLAINS, FOREST]);
  const p2 = player('P2', [LAB_HEX, LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-mutation-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Aura Mutation'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Plains'] },
          { playerId: 'P2', cardNames: ['Lab Hex', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'mutation-viewer-destroy-enchantment-make-saprolings',
      version: 1,
      title: 'Aura Mutation: destroy enchantment, make Saprolings',
      instructions: [
        'Cast Aura Mutation from your hand using the untapped Forest and Plains.',
        'Target the opponent\u2019s Lab Hex. Lab Ox is a creature and must not be a legal target.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Hex is destroyed. You create three 1/1 Saprolings because its mana value is 3. Lab Ox remains.',
      oracleSha256: mutation.sha256,
      clauseIds: ['mutation-destroys-an-enchantment-and-makes-saprolings-equal-to-mana-value'],
    },
    seed,
    seats,
    engine,
  };
}

function mutilateScenario(gameId: GameId): CardTestScenario {
  const mutilate = pinnedFrom(NECRON_MAIN_BATCH1, 'Mutilate');
  const p1 = player('P1', [mutilate.card, SWAMP, SWAMP, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-mutilate-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Mutilate'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'mutilate-viewer-minus-one-per-swamp-all',
      version: 1,
      title: 'Mutilate: -1/-1 per Swamp, all creatures',
      instructions: [
        'Cast Mutilate from your hand using two Swamps and two Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Both creatures get -2/-2. Lab Ox becomes a 2/2. Lab Servo dies. Opponent Swamps would not count.',
      oracleSha256: mutilate.sha256,
      clauseIds: ['mutilate-shrinks-all-creatures-by-your-swamps'],
    },
    seed,
    seats,
    engine,
  };
}

function deathScenario(gameId: GameId): CardTestScenario {
  const death = pinnedFrom(NECRON_REMAINING_BATCH1, 'Their Name Is Death');
  const p1 = player('P1', [death.card, SWAMP, SWAMP, SWAMP, FOREST, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-death-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Their Name Is Death'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Swamp', 'Forest', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'death-viewer-destroy-nonartifact-creatures',
      version: 1,
      title: 'Their Name Is Death: destroy nonartifact creatures',
      instructions: [
        'Cast Their Name Is Death from your hand using three Swamps and three Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox (a nonartifact creature) is destroyed. Lab Servo (an artifact creature) remains.',
      oracleSha256: death.sha256,
      clauseIds: ['death-destroys-nonartifact-creatures-only'],
    },
    seed,
    seats,
    engine,
  };
}

function chainScenario(gameId: GameId): CardTestScenario {
  const chain = pinnedFrom(DRACONIC_BATCH1, 'Chain Reaction');
  const p1 = player('P1', [chain.card, MOUNTAIN, MOUNTAIN, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-chain-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Chain Reaction'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Mountain', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'chain-viewer-damage-equal-to-creature-count',
      version: 1,
      title: 'Chain Reaction: damage equal to creature count',
      instructions: [
        'Cast Chain Reaction from your hand using two Mountains and two Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Two creatures are on the battlefield, so each takes 2 damage. Lab Servo dies. Lab Ox remains with 2 damage marked.',
      oracleSha256: chain.sha256,
      clauseIds: ['chain-damages-each-creature-equal-to-creature-count'],
    },
    seed,
    seats,
    engine,
  };
}

function unconsciousScenario(gameId: GameId): CardTestScenario {
  const unconscious = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Collective Unconscious');
  const p1 = player('P1', [
    unconscious.card,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
    LAB_OX,
    LAB_SERVO,
  ]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-unconscious-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Collective Unconscious'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lab Ox', 'Lab Servo'],
          },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'unconscious-viewer-draw-for-your-creatures',
      version: 1,
      title: 'Collective Unconscious: draw for your creatures',
      instructions: [
        'Cast Collective Unconscious from your hand using six Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'You draw two cards for Lab Ox and Lab Servo. The opponent\u2019s Lab Ox does not add a draw.',
      oracleSha256: unconscious.sha256,
      clauseIds: ['unconscious-draws-for-creatures-you-control'],
    },
    seed,
    seats,
    engine,
  };
}

function camaraderieScenario(gameId: GameId): CardTestScenario {
  const camaraderie = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Camaraderie');
  const p1 = player('P1', [
    camaraderie.card,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    PLAINS,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
    LAB_OX,
    LAB_SERVO,
  ]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-camaraderie-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Camaraderie'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Plains', 'Lab Ox', 'Lab Servo'],
          },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'camaraderie-viewer-life-draw-and-pump',
      version: 1,
      title: 'Camaraderie: life, cards, and +1/+1',
      instructions: [
        'Cast Camaraderie from your hand using five Forests and a Plains.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'You gain 2 life and draw two cards. Your Lab Ox becomes 5/5 and Lab Servo becomes 2/2. The opponent\u2019s Lab Ox stays 4/4.',
      oracleSha256: camaraderie.sha256,
      clauseIds: ['camaraderie-gains-life-draws-and-pumps-equal-to-your-creatures'],
    },
    seed,
    seats,
    engine,
  };
}

function revelationScenario(gameId: GameId): CardTestScenario {
  const revelation = pinnedFrom(DRACONIC_BATCH1, 'Shamanic Revelation');
  const p1 = player('P1', [
    revelation.card,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
    LAB_OX,
    LAB_SERVO,
  ]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-revelation-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Shamanic Revelation'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lab Ox', 'Lab Servo'],
          },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'revelation-viewer-draw-and-life-for-power-four',
      version: 1,
      title: 'Shamanic Revelation: draw creatures, life for power 4',
      instructions: [
        'Cast Shamanic Revelation from your hand using five Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'You draw two cards for your two creatures and gain 4 life for Lab Ox. The opponent\u2019s Lab Ox does not count.',
      oracleSha256: revelation.sha256,
      clauseIds: ['revelation-draws-for-creatures-and-gains-life-for-power-4'],
    },
    seed,
    seats,
    engine,
  };
}

function flayedScenario(gameId: GameId): CardTestScenario {
  const flayed = pinnedFrom(NECRON_MAIN_BATCH1, 'Flayed One');
  const p1 = player('P1', [
    flayed.card,
    SWAMP,
    FOREST,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
  ]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-flayed-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Flayed One'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Swamp', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'flayed-viewer-etb-mill-three-lifelink',
      version: 1,
      title: 'Flayed One: mill three and lifelink',
      instructions: [
        'Cast Flayed One from your hand using the Swamp and two Forests.',
        'Pass priority so it resolves and the enter trigger mills three cards.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Flayed One is a 4/1 with lifelink. Your graveyard has the three milled library cards. Opponents are not milled.',
      oracleSha256: flayed.sha256,
      clauseIds: ['flayed-etb-mills-three-and-has-lifelink'],
    },
    seed,
    seats,
    engine,
  };
}

function scytheScenario(gameId: GameId): CardTestScenario {
  const scythe = pinnedFrom(NECRON_MAIN_BATCH1, 'Night Scythe');
  const p1 = player('P1', [scythe.card, FOREST, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-scythe-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Night Scythe'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'scythe-viewer-etb-necron-warrior',
      version: 1,
      title: 'Night Scythe: create a Necron Warrior',
      instructions: [
        'Cast Night Scythe from your hand using three Forests.',
        'Pass priority so it resolves and the enter trigger creates a Necron Warrior.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome: 'Night Scythe is on the battlefield with a 2/2 Necron Warrior token.',
      oracleSha256: scythe.sha256,
      clauseIds: ['scythe-etb-makes-a-necron-warrior'],
    },
    seed,
    seats,
    engine,
  };
}

function trailScenario(gameId: GameId): CardTestScenario {
  const trail = pinnedFrom(DRACONIC_BATCH1, 'Game Trail');
  const p1 = player('P1', [trail.card, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-trail-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Game Trail', 'Forest'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id: 'trail-viewer-reveal-enters-untapped',
      version: 1,
      title: 'Game Trail: reveal a Forest, enter untapped',
      instructions: [
        'Play Game Trail from your hand.',
        'Reveal the Forest in your hand so Game Trail enters untapped.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Game Trail is untapped. The revealed Forest stays in your hand; you already played a land this turn.',
      oracleSha256: trail.sha256,
      clauseIds: ['trail-enters-untapped-when-you-reveal-a-mountain-or-forest'],
    },
    seed,
    seats,
    engine,
  };
}

function villageScenario(gameId: GameId): CardTestScenario {
  const village = pinnedFrom(TOKEN_TRIUMPH_BATCH1, 'Fortified Village');
  const p1 = player('P1', [village.card, PLAINS, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-village-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Fortified Village', 'Plains'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id: 'village-viewer-reveal-enters-untapped',
      version: 1,
      title: 'Fortified Village: reveal a Plains, enter untapped',
      instructions: [
        'Play Fortified Village from your hand.',
        'Reveal the Plains in your hand so Fortified Village enters untapped.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Fortified Village is untapped. The revealed Plains stays in your hand; you already played a land this turn.',
      oracleSha256: village.sha256,
      clauseIds: ['village-enters-untapped-when-you-reveal-a-forest-or-plains'],
    },
    seed,
    seats,
    engine,
  };
}

function snarlScenario(gameId: GameId): CardTestScenario {
  const snarl = pinnedFrom(SILVERQUILL_REMAINING_BATCH1, 'Shineshadow Snarl');
  const p1 = player('P1', [snarl.card, SWAMP, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-snarl-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Shineshadow Snarl', 'Swamp'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id: 'snarl-viewer-reveal-enters-untapped',
      version: 1,
      title: 'Shineshadow Snarl: reveal a Swamp, enter untapped',
      instructions: [
        'Play Shineshadow Snarl from your hand.',
        'Reveal the Swamp in your hand so Shineshadow Snarl enters untapped.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Shineshadow Snarl is untapped. The revealed Swamp stays in your hand; you already played a land this turn.',
      oracleSha256: snarl.sha256,
      clauseIds: ['snarl-enters-untapped-when-you-reveal-a-plains-or-swamp'],
    },
    seed,
    seats,
    engine,
  };
}

function quakeScenario(gameId: GameId): CardTestScenario {
  const quake = pinnedFrom(DRACONIC_BATCH1, 'Magmaquake');
  const p1 = player('P1', [quake.card, MOUNTAIN, MOUNTAIN, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, LAB_SERVO, LAB_BIRD, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-quake-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Magmaquake'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Mountain', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo', 'Lab Bird'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'quake-viewer-x-damage-spares-flying',
      version: 1,
      title: 'Magmaquake: X damage, spare flying',
      instructions: [
        'Cast Magmaquake from your hand with X = 2 using two Mountains and two Forests.',
        'The spell has no targets. Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox takes 2 damage. Lab Servo dies. Lab Bird has flying and takes no damage.',
      oracleSha256: quake.sha256,
      clauseIds: ['magmaquake-damages-nonflying-creatures-and-planeswalkers-for-x'],
    },
    seed,
    seats,
    engine,
  };
}

function prowessScenario(gameId: GameId): CardTestScenario {
  const prowess = pinnedFrom(DRACONIC_BATCH2, "Hunter's Prowess");
  const p1 = player('P1', [
    prowess.card,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    LAB_OX,
  ]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-prowess-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ["Hunter's Prowess"] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'prowess-viewer-pump-and-trample',
      version: 1,
      title: "Hunter's Prowess: pump and trample",
      instructions: [
        "Cast Hunter's Prowess from your hand using five Forests.",
        'Target your Lab Ox.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox gets +3/+3 and trample until end of turn, becoming a 7/7. Combat-damage draw stays engine-only.',
      oracleSha256: prowess.sha256,
      clauseIds: ['prowess-pumps-grants-trample-and-draws-on-combat-damage'],
    },
    seed,
    seats,
    engine,
  };
}

function wardenScenario(gameId: GameId): CardTestScenario {
  const warden = pinnedFrom(NECRON_MAIN_BATCH2, 'Royal Warden');
  const p1 = player('P1', [warden.card, FOREST, FOREST, FOREST, SWAMP, SWAMP]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-warden-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Royal Warden'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Swamp', 'Swamp'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'warden-viewer-etb-two-tapped-warriors',
      version: 1,
      title: 'Royal Warden: two tapped Necron Warriors',
      instructions: [
        'Cast Royal Warden from your hand using three Forests and two Swamps.',
        'Pass priority so it resolves and the enter trigger creates two tapped Necron Warriors.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Royal Warden is on the battlefield with two tapped 2/2 Necron Warrior tokens. Unearth stays engine-only.',
      oracleSha256: warden.sha256,
      clauseIds: ['warden-etb-makes-two-tapped-warriors-and-unearths-from-the-graveyard'],
    },
    seed,
    seats,
    engine,
  };
}

function provokeScenario(gameId: GameId): CardTestScenario {
  const provoke = pinnedFrom(DRACONIC_BATCH2, 'Provoke the Trolls');
  const p1 = player('P1', [provoke.card, FOREST, FOREST, FOREST, MOUNTAIN, LAB_OX]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-provoke-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Provoke the Trolls'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Mountain', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'provoke-viewer-damage-then-pump',
      version: 1,
      title: 'Provoke the Trolls: damage then pump',
      instructions: [
        'Cast Provoke the Trolls from your hand using three Forests and a Mountain.',
        'Target your Lab Ox.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox takes 3 damage and gets +5/+0 until end of turn, becoming a 9/4. Player-target mode stays engine-only.',
      oracleSha256: provoke.sha256,
      clauseIds: ['provoke-pumps-a-creature-after-dealing-damage'],
    },
    seed,
    seats,
    engine,
  };
}

function smelterScenario(gameId: GameId): CardTestScenario {
  const smelter = pinnedFrom(DRACONIC_BATCH2, 'Hoard-Smelter Dragon');
  const p1 = player('P1', [smelter.card, FOREST, FOREST, FOREST, MOUNTAIN]);
  const p2 = player('P2', [WRONG_MV, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-smelter-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Hoard-Smelter Dragon', 'Forest', 'Forest', 'Forest', 'Mountain'],
          },
          { playerId: 'P2', cardNames: ['Wrong-MV Artifact'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'smelter-viewer-destroy-artifact-and-pump',
      version: 1,
      title: 'Hoard-Smelter Dragon: destroy artifact and pump',
      instructions: [
        'Activate Hoard-Smelter Dragon using three Forests and a Mountain.',
        'Target the opponent\u2019s Wrong-MV Artifact. A creature would be an illegal target.',
        'Pass priority so the ability resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Wrong-MV Artifact is destroyed. Hoard-Smelter Dragon gets +3/+0 until end of turn, becoming an 8/5.',
      oracleSha256: smelter.sha256,
      clauseIds: ['smelter-destroys-an-artifact-and-pumps-by-its-mana-value'],
    },
    seed,
    seats,
    engine,
  };
}

function loamingScenario(gameId: GameId): CardTestScenario {
  const shaman = pinnedFrom(DRACONIC_BATCH2, 'Loaming Shaman');
  const p1 = player('P1', [shaman.card, FOREST, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-loaming-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Loaming Shaman'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest'] }],
        graveyard: [{ playerId: 'P2', cardNames: ['Lab Ox'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'loaming-viewer-shuffle-chosen-graveyard-card',
      version: 1,
      title: 'Loaming Shaman: shuffle a graveyard card',
      instructions: [
        'Cast Loaming Shaman from your hand using three Forests.',
        'Target opponent P2 with the enter-the-battlefield ability.',
        'Choose Lab Ox from P2\u2019s graveyard, then stop choosing further cards.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2\u2019s Lab Ox is shuffled into their library. Choosing zero cards stays engine-only.',
      oracleSha256: shaman.sha256,
      clauseIds: ['loaming-shuffles-chosen-graveyard-cards-into-that-library'],
    },
    seed,
    seats,
    engine,
  };
}

function chronoScenario(gameId: GameId): CardTestScenario {
  const chrono = pinnedFrom(NECRON_MAIN_BATCH2, 'Chronomancer');
  const p1 = player('P1', [chrono.card, LAB_SERVO, FOREST, ELIGIBLE]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-chrono-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [{ playerId: 'P1', cardNames: ['Chronomancer', 'Lab Servo', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'chrono-viewer-sac-artifact-draw',
      version: 1,
      title: 'Chronomancer: sacrifice an artifact, draw',
      instructions: [
        'Activate Chronomancer\u2019s Atomic Transmutation using the Forest, tapping Chronomancer, and sacrificing Lab Servo.',
        'Pass priority so the ability resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Servo is sacrificed. You draw Eligible Talisman. Chronomancer stays on the battlefield. Unearth stays engine-only.',
      oracleSha256: chrono.sha256,
      clauseIds: ['chrono-flies-and-sacs-another-artifact-to-draw-not-itself'],
    },
    seed,
    seats,
    engine,
  };
}

function akoumScenario(gameId: GameId): CardTestScenario {
  const akoum = pinnedFrom(DRACONIC_BATCH1, 'Akoum Hellkite');
  const p1 = player('P1', [akoum.card, MOUNTAIN, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-akoum-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Mountain'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Akoum Hellkite'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'akoum-viewer-mountain-landfall-two',
      version: 1,
      title: 'Akoum Hellkite: Mountain landfall deals 2',
      instructions: [
        'Play the Mountain from your hand.',
        'Target opponent P2 with the landfall trigger.',
        'Pass priority so the trigger resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2 loses 2 life. A Forest landfall would deal 1; opponent lands do not fire. Those cases stay engine-only.',
      oracleSha256: akoum.sha256,
      clauseIds: ['akoum-landfall-deals-two-if-the-land-is-a-mountain'],
    },
    seed,
    seats,
    engine,
  };
}

function dawnScenario(gameId: GameId): CardTestScenario {
  const dawn = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Dawn of Hope');
  const p1 = player('P1', [dawn.card, FOREST, FOREST, FOREST, PLAINS]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-dawn-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [
          { playerId: 'P1', cardNames: ['Dawn of Hope', 'Forest', 'Forest', 'Forest', 'Plains'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'dawn-viewer-make-lifelink-soldier',
      version: 1,
      title: 'Dawn of Hope: create a lifelink Soldier',
      instructions: [
        'Activate Dawn of Hope using three Forests and a Plains.',
        'Pass priority so the ability resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'A 1/1 Soldier token with lifelink enters. The life-gain draw rider stays engine-only.',
      oracleSha256: dawn.sha256,
      clauseIds: ['dawn-activation-makes-a-lifelink-soldier'],
    },
    seed,
    seats,
    engine,
  };
}

function rootbornScenario(gameId: GameId): CardTestScenario {
  const rootborn = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Rootborn Defenses');
  const p1 = player('P1', [rootborn.card, FOREST, FOREST, PLAINS, LAB_OX]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-rootborn-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Rootborn Defenses'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Plains', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'rootborn-viewer-indestructible-no-token',
      version: 1,
      title: 'Rootborn Defenses: grant indestructible',
      instructions: [
        'Cast Rootborn Defenses from your hand using two Forests and a Plains.',
        'Pass priority so it resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox gains indestructible until end of turn. Populate of a token you control stays engine-only.',
      oracleSha256: rootborn.sha256,
      clauseIds: ['rootborn-does-not-copy-an-opponent-token-and-still-grants-indestructible'],
    },
    seed,
    seats,
    engine,
  };
}

function trostaniScenario(gameId: GameId): CardTestScenario {
  const trostani = pinnedFrom(TOKEN_TRIUMPH_BATCH3, 'Trostani Discordant');
  const p1 = player('P1', [trostani.card, FOREST, FOREST, FOREST, PLAINS]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-trostani-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Trostani Discordant'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Plains'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'trostani-viewer-etb-two-lifelink-soldiers',
      version: 1,
      title: 'Trostani Discordant: two lifelink Soldiers',
      instructions: [
        'Cast Trostani Discordant from your hand using three Forests and a Plains.',
        'Pass priority so it resolves and the enter trigger creates two Soldiers.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Trostani is on the battlefield with two 2/2 lifelink Soldiers (anthem). End-step stolen-creature return stays engine-only.',
      oracleSha256: trostani.sha256,
      clauseIds: ['trostani-etb-makes-two-lifelink-soldiers-and-anthem-pumps-yours'],
    },
    seed,
    seats,
    engine,
  };
}

function felidarScenario(gameId: GameId): CardTestScenario {
  const felidar = pinnedFrom(TOKEN_TRIUMPH_BATCH3, 'Felidar Retreat');
  const p1 = player('P1', [felidar.card, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-felidar-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Forest'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Felidar Retreat'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'felidar-viewer-landfall-cat-beast',
      version: 1,
      title: 'Felidar Retreat: landfall Cat Beast',
      instructions: [
        'Play the Forest from your hand.',
        'Choose the Cat Beast landfall mode.',
        'Pass priority so the trigger resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'A 2/2 Cat Beast token enters. The +1/+1 and vigilance mode and opponent-land cases stay engine-only.',
      oracleSha256: felidar.sha256,
      clauseIds: ['felidar-landfall-can-make-a-cat-beast-or-pump-with-vigilance'],
    },
    seed,
    seats,
    engine,
  };
}

function nestScenario(gameId: GameId): CardTestScenario {
  const nest = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Hornet Nest');
  const p1 = player('P1', [nest.card, LAB_SHOCK, MOUNTAIN]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-nest-v1';
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Shock'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Hornet Nest', 'Mountain'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'nest-viewer-damage-makes-insects',
      version: 1,
      title: 'Hornet Nest: damage makes Insects',
      instructions: [
        'Cast Lab Shock targeting your Hornet Nest using the Mountain.',
        'Pass priority so the spell deals 2 damage and the Nest trigger creates two Insects.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Hornet Nest dies. Two 1/1 Insects with flying and deathtouch enter. Damage to another creature stays engine-only.',
      oracleSha256: nest.sha256,
      clauseIds: ['nest-makes-insects-equal-to-damage-dealt'],
    },
    seed,
    seats,
    engine,
  };
}

/** Step 15 evaluates only the five repaired cards. Catalog leftover lab scenarios must stay out. */
export const REVIEWED_FIVE_SCENARIO_IDS = [
  'tribute-viewer-cast-search-select-resolve',
  'gev-viewer-opponent-targets-ward',
  'nightscape-viewer-activate-regenerate-destroy',
  'thran-viewer-graveyard-departure-trigger',
  'harmonic-viewer-cast-and-double-trigger',
] as const;

export const CARD_TEST_SCENARIO_IDS = [
  ...REVIEWED_FIVE_SCENARIO_IDS,
  'swords-viewer-exile-and-gain-life',
  'throat-viewer-destroy-nonartifact',
  'defense-viewer-pump-and-hexproof',
  'bog-viewer-exile-targeted-graveyard',
  'bust-viewer-destroy-toughness-four-or-greater',
  'defile-viewer-minus-one-per-swamp',
  'fury-viewer-double-power',
  'mutation-viewer-destroy-enchantment-make-saprolings',
  'mutilate-viewer-minus-one-per-swamp-all',
  'death-viewer-destroy-nonartifact-creatures',
  'chain-viewer-damage-equal-to-creature-count',
  'unconscious-viewer-draw-for-your-creatures',
  'camaraderie-viewer-life-draw-and-pump',
  'revelation-viewer-draw-and-life-for-power-four',
  'flayed-viewer-etb-mill-three-lifelink',
  'scythe-viewer-etb-necron-warrior',
  'trail-viewer-reveal-enters-untapped',
  'village-viewer-reveal-enters-untapped',
  'snarl-viewer-reveal-enters-untapped',
  'quake-viewer-x-damage-spares-flying',
  'prowess-viewer-pump-and-trample',
  'warden-viewer-etb-two-tapped-warriors',
  'provoke-viewer-damage-then-pump',
  'smelter-viewer-destroy-artifact-and-pump',
  'loaming-viewer-shuffle-chosen-graveyard-card',
  'chrono-viewer-sac-artifact-draw',
  'akoum-viewer-mountain-landfall-two',
  'dawn-viewer-make-lifelink-soldier',
  'rootborn-viewer-indestructible-no-token',
  'trostani-viewer-etb-two-lifelink-soldiers',
  'felidar-viewer-landfall-cat-beast',
  'nest-viewer-damage-makes-insects',
] as const;

const SCENARIO_BUILDERS: Record<string, (gameId: GameId) => CardTestScenario> = {
  'tribute-viewer-cast-search-select-resolve': tributeMageScenario,
  'gev-viewer-opponent-targets-ward': gevWardScenario,
  'nightscape-viewer-activate-regenerate-destroy': nightscapeScenario,
  'thran-viewer-graveyard-departure-trigger': thranVigilScenario,
  'harmonic-viewer-cast-and-double-trigger': harmonicProdigyScenario,
  'swords-viewer-exile-and-gain-life': swordsScenario,
  'throat-viewer-destroy-nonartifact': throatScenario,
  'defense-viewer-pump-and-hexproof': blossomingScenario,
  'bog-viewer-exile-targeted-graveyard': bogScenario,
  'bust-viewer-destroy-toughness-four-or-greater': bustScenario,
  'defile-viewer-minus-one-per-swamp': defileScenario,
  'fury-viewer-double-power': furyScenario,
  'mutation-viewer-destroy-enchantment-make-saprolings': mutationScenario,
  'mutilate-viewer-minus-one-per-swamp-all': mutilateScenario,
  'death-viewer-destroy-nonartifact-creatures': deathScenario,
  'chain-viewer-damage-equal-to-creature-count': chainScenario,
  'unconscious-viewer-draw-for-your-creatures': unconsciousScenario,
  'camaraderie-viewer-life-draw-and-pump': camaraderieScenario,
  'revelation-viewer-draw-and-life-for-power-four': revelationScenario,
  'flayed-viewer-etb-mill-three-lifelink': flayedScenario,
  'scythe-viewer-etb-necron-warrior': scytheScenario,
  'trail-viewer-reveal-enters-untapped': trailScenario,
  'village-viewer-reveal-enters-untapped': villageScenario,
  'snarl-viewer-reveal-enters-untapped': snarlScenario,
  'quake-viewer-x-damage-spares-flying': quakeScenario,
  'prowess-viewer-pump-and-trample': prowessScenario,
  'warden-viewer-etb-two-tapped-warriors': wardenScenario,
  'provoke-viewer-damage-then-pump': provokeScenario,
  'smelter-viewer-destroy-artifact-and-pump': smelterScenario,
  'loaming-viewer-shuffle-chosen-graveyard-card': loamingScenario,
  'chrono-viewer-sac-artifact-draw': chronoScenario,
  'akoum-viewer-mountain-landfall-two': akoumScenario,
  'dawn-viewer-make-lifelink-soldier': dawnScenario,
  'rootborn-viewer-indestructible-no-token': rootbornScenario,
  'trostani-viewer-etb-two-lifelink-soldiers': trostaniScenario,
  'felidar-viewer-landfall-cat-beast': felidarScenario,
  'nest-viewer-damage-makes-insects': nestScenario,
};

export function createCardTestScenario(
  scenarioId: string,
  gameId: GameId,
): CardTestScenario | null {
  const builder = SCENARIO_BUILDERS[scenarioId];
  return builder === undefined ? null : builder(gameId);
}

/** Catalog for the lab page's scenario picker: metadata only, engines are discarded. */
export function listCardTestScenarios(): CardTestScenarioMetadata[] {
  return CARD_TEST_SCENARIO_IDS.map(
    (scenarioId) => createCardTestScenario(scenarioId, 'card-lab-catalog' as GameId)!.metadata,
  );
}
