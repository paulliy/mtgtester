import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { choose, Engine, ScriptedDecisionProvider } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { CardTestScenarioMetadata, Color, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { SeatSetup } from '../match/setup';

export interface CardTestScenario {
  metadata: CardTestScenarioMetadata;
  seed: string;
  seats: SeatSetup[];
  engine: Engine;
  /** Optional deterministic bot choices used only by the real Card Test Lab session. */
  decisionProviderOverrides?: Partial<Record<PlayerId, DecisionProvider>>;
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

const QUEEN_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/queen-engine-batch1-oracle.json'), 'utf8'),
) as PinnedOracleFile;

const QUEEN_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/queen-engine-batch2-oracle.json'), 'utf8'),
) as PinnedOracleFile;

const QUEEN_BATCH3: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/queen-engine-batch3-oracle.json'), 'utf8'),
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

const DRACONIC_BATCH3: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/draconic-engine-batch3-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const NECRON_MAIN_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/necron-main-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const LIVING_ENERGY_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/living-energy-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const LIVING_ENERGY_BATCH2: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/living-energy-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const LIVING_ENERGY_BATCH5: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/living-energy-engine-batch5-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const W2_REMAINING_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(
    resolve('packages/engine/tests/fixtures/w2-remaining-engine-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedOracleFile;

const MARCHESA_BATCH1: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/marchesa-batch1-oracle.json'), 'utf8'),
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

const ARCANE_PENDING_SPELL = card({
  oracleId: 'lab-arcane-pending-spell',
  name: 'Lab Pending Spell',
  typeLine: 'Instant',
  manaCost: '{1}',
  cmc: 1,
  oracleText: 'Draw a card.',
});

const ARCANE_CASTER_SECRET = card({
  oracleId: 'lab-arcane-caster-secret',
  name: 'Caster Secret Draw',
  typeLine: 'Creature — Secret',
});

const ARCANE_TARGET_SECRET_A = card({
  oracleId: 'lab-arcane-target-secret-a',
  name: 'Target Secret Alpha',
  typeLine: 'Creature — Secret',
});

const ARCANE_TARGET_SECRET_B = card({
  oracleId: 'lab-arcane-target-secret-b',
  name: 'Target Secret Beta',
  typeLine: 'Creature — Secret',
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
      expectedOutcome: 'Lab Ox gets +2/+2 and hexproof until end of turn, becoming a 6/6.',
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
      expectedOutcome: 'Lab Ox (toughness 4) is destroyed. Lab Servo (toughness 1) remains.',
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
            cardNames: [
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Lab Ox',
              'Lab Servo',
            ],
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
            cardNames: [
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Plains',
              'Lab Ox',
              'Lab Servo',
            ],
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
  const p1 = player('P1', [prowess.card, FOREST, FOREST, FOREST, FOREST, FOREST, LAB_OX]);
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
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lab Ox'],
          },
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
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Plains', 'Lab Ox'] }],
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
  const p1 = player('P1', [trostani.card, FOREST, FOREST, FOREST, FOREST, PLAINS]);
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
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Plains'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'trostani-viewer-etb-two-lifelink-soldiers',
      version: 1,
      title: 'Trostani Discordant: two lifelink Soldiers',
      instructions: [
        'Cast Trostani Discordant from your hand using four Forests and a Plains.',
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

function slateScenario(gameId: GameId): CardTestScenario {
  const slate = pinnedFrom(TOKEN_TRIUMPH_BATCH2, 'Slate of Ancestry');
  const p1 = player('P1', [
    slate.card,
    FOREST,
    FOREST,
    FOREST,
    FOREST,
    LAB_OX,
    LAB_SERVO,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
    WRONG_TYPE,
  ]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-slate-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Eligible Talisman', 'Eligible Signet'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: [
              'Slate of Ancestry',
              'Forest',
              'Forest',
              'Forest',
              'Forest',
              'Lab Ox',
              'Lab Servo',
            ],
          },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'slate-viewer-discard-and-draw-for-creatures',
      version: 1,
      title: 'Slate of Ancestry: discard and draw for creatures',
      instructions: [
        'Activate Slate of Ancestry using four Forests, tapping it, and discarding your hand.',
        'Pass priority so the ability draws a card for each creature you control.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Your two hand cards are discarded and you draw two nonlands for Lab Ox and Lab Servo. Opponent creatures stay engine-only.',
      oracleSha256: slate.sha256,
      clauseIds: ['slate-discards-hand-and-draws-for-creatures-you-control'],
    },
    seed,
    seats,
    engine,
  };
}

function scarabScenario(gameId: GameId): CardTestScenario {
  const scarab = pinnedFrom(NECRON_REMAINING_BATCH1, 'Canoptek Scarab Swarm');
  const p1 = player('P1', [scarab.card, FOREST, FOREST, FOREST, FOREST]);
  const p2 = player('P2', [ELIGIBLE, FOREST, LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-scarab-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Canoptek Scarab Swarm'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Forest'] }],
        graveyard: [{ playerId: 'P2', cardNames: ['Eligible Talisman', 'Forest', 'Lab Ox'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'scarab-viewer-exile-graveyard-make-insects',
      version: 1,
      title: 'Canoptek Scarab Swarm: exile graveyard, make Insects',
      instructions: [
        'Cast Canoptek Scarab Swarm from your hand using four Forests.',
        'Target opponent P2 with the enter-the-battlefield ability.',
        'Pass priority so P2\u2019s graveyard is exiled and Insects are created for the artifact and land.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2\u2019s graveyard is exiled. Two flying Insect tokens enter for the artifact and land. A creature-only graveyard stays engine-only.',
      oracleSha256: scarab.sha256,
      clauseIds: ['scarab-exiles-graveyard-and-makes-insects-for-artifacts-and-lands'],
    },
    seed,
    seats,
    engine,
  };
}

function oakScenario(gameId: GameId): CardTestScenario {
  const oak = pinnedFrom(TOKEN_TRIUMPH_BATCH1, 'Great Oak Guardian');
  const p1 = player('P1', [oak.card, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-oak-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Great Oak Guardian'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
          },
          { playerId: 'P2', cardNames: ['Lab Ox'], tapped: true },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'oak-viewer-pump-and-untap-target-player',
      version: 1,
      title: 'Great Oak Guardian: pump and untap P2 creatures',
      instructions: [
        'Cast Great Oak Guardian from your hand using six Forests.',
        'Target opponent P2 with the enter-the-battlefield ability.',
        'Pass priority so P2\u2019s Lab Ox gets +2/+2 and untaps.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2\u2019s Lab Ox becomes a 6/6 and untaps. Your Great Oak Guardian stays 4/5. Pumping a different player stays engine-only.',
      oracleSha256: oak.sha256,
      clauseIds: ['oak-untaps-and-pumps-the-targeted-players-creatures'],
    },
    seed,
    seats,
    engine,
  };
}

function frostboilScenario(gameId: GameId): CardTestScenario {
  const frostboil = pinnedFrom(LIVING_ENERGY_BATCH2, 'Frostboil Snarl');
  const p1 = player('P1', [frostboil.card, ISLAND, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-frostboil-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Frostboil Snarl', 'Island'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id: 'frostboil-viewer-reveal-enters-untapped',
      version: 1,
      title: 'Frostboil Snarl: reveal an Island, enter untapped',
      instructions: [
        'Play Frostboil Snarl from your hand.',
        'Reveal the Island in your hand so Frostboil Snarl enters untapped.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Frostboil Snarl is untapped. The revealed Island stays in your hand; you already played a land this turn.',
      oracleSha256: frostboil.sha256,
      clauseIds: ['frostboil-enters-untapped-only-if-you-reveal-an-island-or-mountain'],
    },
    seed,
    seats,
    engine,
  };
}

function vineglimmerScenario(gameId: GameId): CardTestScenario {
  const vineglimmer = pinnedFrom(LIVING_ENERGY_BATCH2, 'Vineglimmer Snarl');
  const p1 = player('P1', [vineglimmer.card, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-vineglimmer-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Vineglimmer Snarl', 'Forest'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id: 'vineglimmer-viewer-reveal-enters-untapped',
      version: 1,
      title: 'Vineglimmer Snarl: reveal a Forest, enter untapped',
      instructions: [
        'Play Vineglimmer Snarl from your hand.',
        'Reveal the Forest in your hand so Vineglimmer Snarl enters untapped.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Vineglimmer Snarl is untapped. The revealed Forest stays in your hand; you already played a land this turn. A Plains would not qualify.',
      oracleSha256: vineglimmer.sha256,
      clauseIds: ['vineglimmer-does-not-reveal-a-plains'],
    },
    seed,
    seats,
    engine,
  };
}

function strokeScenario(gameId: GameId): CardTestScenario {
  const stroke = pinnedFrom(QUEEN_BATCH2, 'Stroke of Midnight');
  const p1 = player('P1', [stroke.card, PLAINS, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-stroke-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Stroke of Midnight'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'stroke-viewer-destroy-nonland-make-human',
      version: 1,
      title: 'Stroke of Midnight: destroy nonland, make a Human',
      instructions: [
        'Cast Stroke of Midnight from your hand using the untapped Plains and Forests.',
        'Target the opponent\u2019s Lab Ox. Lands are not legal targets.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is destroyed. P2 creates a 1/1 white Human. Targeting a land stays engine-only.',
      oracleSha256: stroke.sha256,
      clauseIds: ['stroke-destroys-nonland-and-makes-human'],
    },
    seed,
    seats,
    engine,
  };
}

function giftScenario(gameId: GameId): CardTestScenario {
  const gift = pinnedFrom(QUEEN_BATCH2, 'Generous Gift');
  const p1 = player('P1', [gift.card, PLAINS, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-gift-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Generous Gift'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'gift-viewer-destroy-and-make-elephant',
      version: 1,
      title: 'Generous Gift: destroy Lab Ox, make an Elephant',
      instructions: [
        'Cast Generous Gift from your hand using the untapped Plains and Forests.',
        'Target the opponent\u2019s Lab Ox. Lands are also legal; do not choose them.',
        'Pass priority so the spell resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is destroyed. P2 creates a 3/3 green Elephant. Targeting a land stays engine-only.',
      oracleSha256: gift.sha256,
      clauseIds: ['gift-destroys-and-makes-elephant'],
    },
    seed,
    seats,
    engine,
  };
}

function bounceLandScenario(
  gameId: GameId,
  land: { card: OracleCard; sha256: string },
  opts: { id: string; title: string; seed: string; clauseId: string },
): CardTestScenario {
  const p1 = player('P1', [land.card, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const engine = new Engine(
    {
      gameId,
      seed: opts.seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: [land.card.name] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: opts.id,
      version: 1,
      title: opts.title,
      instructions: [
        `Play ${land.card.name} from your hand.`,
        'Return the Forest you control so the bounce land stays on the battlefield.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome: `${land.card.name} is tapped. The Forest is back in your hand. Bouncing the bounce land itself stays engine-only.`,
      oracleSha256: land.sha256,
      clauseIds: [opts.clauseId],
    },
    seed: opts.seed,
    seats,
    engine,
  };
}

function garrisonScenario(gameId: GameId): CardTestScenario {
  return bounceLandScenario(gameId, pinnedFrom(QUEEN_BATCH3, 'Boros Garrison'), {
    id: 'garrison-viewer-bounce-forest-enters-tapped',
    title: 'Boros Garrison: bounce Forest, enter tapped',
    seed: 'card-lab-garrison-v1',
    clauseId: 'boros-garrison-enters-tapped-and-can-bounce-another-land',
  });
}

function basilicaScenario(gameId: GameId): CardTestScenario {
  return bounceLandScenario(gameId, pinnedFrom(QUEEN_BATCH3, 'Orzhov Basilica'), {
    id: 'basilica-viewer-bounce-forest-enters-tapped',
    title: 'Orzhov Basilica: bounce Forest, enter tapped',
    seed: 'card-lab-basilica-v1',
    clauseId: 'orzhov-basilica-enters-tapped-and-can-bounce-another-land',
  });
}

function carnariumScenario(gameId: GameId): CardTestScenario {
  return bounceLandScenario(gameId, pinnedFrom(QUEEN_BATCH3, 'Rakdos Carnarium'), {
    id: 'carnarium-viewer-bounce-forest-enters-tapped',
    title: 'Rakdos Carnarium: bounce Forest, enter tapped',
    seed: 'card-lab-carnarium-v1',
    clauseId: 'rakdos-carnarium-enters-tapped-and-can-bounce-another-land',
  });
}

function piaKiranScenario(gameId: GameId): CardTestScenario {
  const pair = pinnedFrom(LIVING_ENERGY_BATCH5, 'Pia and Kiran Nalaar');
  const p1 = player('P1', [pair.card, MOUNTAIN, MOUNTAIN, MOUNTAIN, MOUNTAIN]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-pia-kiran-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Pia and Kiran Nalaar'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Mountain', 'Mountain', 'Mountain'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'pia-kiran-viewer-etb-two-thopters',
      version: 1,
      title: 'Pia and Kiran Nalaar: two flying Thopters',
      instructions: [
        'Cast Pia and Kiran Nalaar from your hand using four Mountains.',
        'Pass priority so the enter trigger creates two Thopters.',
        'Pass leftover activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Pia and Kiran Nalaar is on the battlefield with two 1/1 flying Thopter tokens. Sacrificing an artifact for damage stays engine-only.',
      oracleSha256: pair.sha256,
      clauseIds: ['pia-kiran-etb-makes-two-thopters-and-sacing-an-artifact-deals-two'],
    },
    seed,
    seats,
    engine,
  };
}

function cracklingScenario(gameId: GameId): CardTestScenario {
  const doom = pinnedFrom(QUEEN_BATCH1, 'Crackling Doom');
  const p1 = player('P1', [doom.card, MOUNTAIN, PLAINS, SWAMP]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-crackling-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Crackling Doom'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Plains', 'Swamp'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'crackling-viewer-damage-and-greatest-sacrifice',
      version: 1,
      title: 'Crackling Doom: opponents take 2, P2 sacs Lab Ox',
      instructions: [
        'Cast Crackling Doom from your hand using the Mountain, Plains, and Swamp.',
        'Pass priority so each opponent takes 2 and P2 sacrifices Lab Ox.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is sacrificed. Each opponent loses 2 life. You do not. An opponent with no creature still taking 2 stays engine-only.',
      oracleSha256: doom.sha256,
      clauseIds: ['crackling-opponents-damage-and-greatest-sacrifice'],
    },
    seed,
    seats,
    engine,
  };
}

function whirlerScenario(gameId: GameId): CardTestScenario {
  const rogue = pinnedFrom(LIVING_ENERGY_BATCH5, 'Whirler Rogue');
  const p1 = player('P1', [rogue.card, ISLAND, ISLAND, ISLAND, ISLAND]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-whirler-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Whirler Rogue'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Island', 'Island', 'Island'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'whirler-viewer-etb-two-thopters',
      version: 1,
      title: 'Whirler Rogue: two flying Thopters',
      instructions: [
        'Cast Whirler Rogue from your hand using four Islands.',
        'Pass priority so the enter trigger creates two Thopters.',
        'Pass leftover activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Whirler Rogue is on the battlefield with two 1/1 flying Thopter tokens. Tapping two artifacts for unblockable stays engine-only.',
      oracleSha256: rogue.sha256,
      clauseIds: ['rogue-etb-makes-two-thopters-and-tapping-two-artifacts-unblockable'],
    },
    seed,
    seats,
    engine,
  };
}

function weaverScenario(gameId: GameId): CardTestScenario {
  const weaver = pinnedFrom(LIVING_ENERGY_BATCH2, 'Reckless Fireweaver');
  const p1 = player('P1', [weaver.card, FOREST, FOREST, ELIGIBLE]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-weaver-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Eligible Talisman'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Reckless Fireweaver', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'weaver-viewer-artifact-etb-pings-opponents',
      version: 1,
      title: 'Reckless Fireweaver: artifact ETB pings opponents',
      instructions: [
        'Cast Eligible Talisman from your hand using two Forests.',
        'Pass priority so Reckless Fireweaver deals 1 to each opponent.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Eligible Talisman is on the battlefield. Each opponent loses 1 life. You do not. A nonartifact creature entering stays engine-only.',
      oracleSha256: weaver.sha256,
      clauseIds: ['weaver-pings-each-opponent-when-your-artifact-enters-not-a-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function spitFlameScenario(gameId: GameId): CardTestScenario {
  const spit = pinnedFrom(DRACONIC_BATCH3, 'Spit Flame');
  const p1 = player('P1', [spit.card, MOUNTAIN, FOREST, FOREST]);
  const p2 = player('P2', [LAB_OX, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-spit-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Spit Flame'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'spit-viewer-four-damage-to-ox',
      version: 1,
      title: 'Spit Flame: 4 damage to Lab Ox',
      instructions: [
        'Cast Spit Flame from your hand using the Mountain and Forests.',
        'Target the opponent\u2019s Lab Ox.',
        'Pass priority so 4 damage resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox dies to 4 damage. Paying {R} to return Spit Flame when a Dragon enters stays engine-only.',
      oracleSha256: spit.sha256,
      clauseIds: ['spit-deals-four-to-target-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function saiScenario(gameId: GameId): CardTestScenario {
  const sai = pinnedFrom(LIVING_ENERGY_BATCH5, 'Sai, Master Thopterist');
  const p1 = player('P1', [sai.card, FOREST, FOREST, ELIGIBLE]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-sai-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Eligible Talisman'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Sai, Master Thopterist', 'Forest', 'Forest'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'sai-viewer-cast-artifact-makes-thopter',
      version: 1,
      title: 'Sai, Master Thopterist: artifact makes a Thopter',
      instructions: [
        'Cast Eligible Talisman from your hand using two Forests.',
        'Pass priority so Sai creates a Thopter.',
        'Pass leftover activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Eligible Talisman is on the battlefield with a 1/1 flying Thopter. Casting a creature does not make a Thopter; that case stays engine-only.',
      oracleSha256: sai.sha256,
      clauseIds: ['sai-makes-a-thopter-when-you-cast-an-artifact-not-a-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function rendezvousScenario(gameId: GameId): CardTestScenario {
  const rendezvous = pinnedFrom(QUEEN_BATCH1, 'Secret Rendezvous');
  const p1 = player('P1', [
    rendezvous.card,
    PLAINS,
    PLAINS,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
  ]);
  const p2 = player('P2', [ELIGIBLE, ELIGIBLE_SIGNET, WRONG_MV, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-rendezvous-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Secret Rendezvous'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Plains', 'Plains', 'Forest'] },
          { playerId: 'P2', cardNames: ['Forest', 'Forest', 'Forest'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'rendezvous-viewer-you-and-opponent-draw-three',
      version: 1,
      title: 'Secret Rendezvous: you and P2 each draw three',
      instructions: [
        'Cast Secret Rendezvous from your hand using two Plains and a Forest.',
        'Target opponent P2. You cannot target yourself.',
        'Pass priority so both of you draw three nonlands.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'You and P2 each draw three nonland cards. P3 does not. Targeting yourself stays illegal in engine tests.',
      oracleSha256: rendezvous.sha256,
      clauseIds: ['rendezvous-you-and-target-opponent-draw-three'],
    },
    seed,
    seats,
    engine,
  };
}

function demandingDragonScenario(gameId: GameId): CardTestScenario {
  const dragon = pinnedFrom(DRACONIC_BATCH2, 'Demanding Dragon');
  const p1 = player('P1', [dragon.card, MOUNTAIN, MOUNTAIN, FOREST, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-demanding-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Demanding Dragon'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Mountain', 'Mountain', 'Forest', 'Forest', 'Forest'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'demanding-viewer-five-damage-no-creature',
      version: 1,
      title: 'Demanding Dragon: 5 damage when P2 has no creature',
      instructions: [
        'Cast Demanding Dragon from your hand using two Mountains and three Forests.',
        'Target opponent P2 with the enter trigger. P2 has no creature to sacrifice.',
        'Pass priority so 5 damage resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2 loses 5 life. You do not. Sacrificing a creature to avoid the damage stays engine-only.',
      oracleSha256: dragon.sha256,
      clauseIds: ['demanding-deals-five-when-the-opponent-has-no-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function cryptothrallScenario(gameId: GameId): CardTestScenario {
  const cryptothrall = pinnedFrom(NECRON_MAIN_BATCH1, 'Cryptothrall');
  const p1 = player('P1', [cryptothrall.card, LAB_SERVO, LAB_OX, FOREST, FOREST, FOREST, FOREST]);
  const p2 = player('P2', [LAB_SERVO, FOREST, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-cryptothrall-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Cryptothrall'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Lab Servo', 'Lab Ox', 'Forest', 'Forest', 'Forest', 'Forest'],
          },
          { playerId: 'P2', cardNames: ['Lab Servo'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'cryptothrall-viewer-hexproof-other-artifact-creatures',
      version: 1,
      title: 'Cryptothrall: your other artifact creature has hexproof',
      instructions: [
        'Cast Cryptothrall from your hand using four Forests.',
        'Pass priority so Protector applies to your other artifact creatures.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        "Your Lab Servo has hexproof. Cryptothrall itself, your Lab Ox, and P2's Lab Servo do not.",
      oracleSha256: cryptothrall.sha256,
      clauseIds: ['cryptothrall-hexproof-other-artifact-creatures-you-control'],
    },
    seed,
    seats,
    engine,
  };
}

function borosCharmScenario(gameId: GameId): CardTestScenario {
  const charm = pinnedFrom(QUEEN_BATCH3, 'Boros Charm');
  const p1 = player('P1', [charm.card, MOUNTAIN, PLAINS, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-boros-charm-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Boros Charm'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Mountain', 'Plains', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'boros-charm-viewer-four-damage-to-player',
      version: 1,
      title: 'Boros Charm: 4 damage to P2',
      instructions: [
        'Cast Boros Charm from your hand using the Mountain and Plains.',
        'Choose the deal-4-damage mode. Double strike is illegal with no creature.',
        'Target opponent P2.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2 loses 4 life. You do not. Indestructible and double-strike modes stay engine-only.',
      oracleSha256: charm.sha256,
      clauseIds: ['boros-charm-damage-player'],
    },
    seed,
    seats,
    engine,
  };
}

function rakdosCharmScenario(gameId: GameId): CardTestScenario {
  const charm = pinnedFrom(QUEEN_BATCH3, 'Rakdos Charm');
  const p1 = player('P1', [charm.card, SWAMP, MOUNTAIN, FOREST]);
  const p2 = player('P2', [WRONG_MV, LAB_OX, FOREST, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-rakdos-charm-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Rakdos Charm'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Swamp', 'Mountain', 'Forest'] },
          { playerId: 'P2', cardNames: ['Wrong-MV Artifact', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'rakdos-charm-viewer-destroy-artifact',
      version: 1,
      title: 'Rakdos Charm: destroy Wrong-MV Artifact',
      instructions: [
        'Cast Rakdos Charm from your hand using the Swamp and Mountain.',
        'Choose the destroy-artifact mode. Lab Ox is an illegal target for that mode.',
        'Target the opponent\u2019s Wrong-MV Artifact.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Wrong-MV Artifact is destroyed. Lab Ox remains. Graveyard-exile and creature-ping modes stay engine-only.',
      oracleSha256: charm.sha256,
      clauseIds: ['rakdos-charm-destroys-artifact-not-creature'],
    },
    seed,
    seats,
    engine,
  };
}

function steelHellkiteScenario(gameId: GameId): CardTestScenario {
  const hellkite = pinnedFrom(DRACONIC_BATCH3, 'Steel Hellkite');
  const p1 = player('P1', [hellkite.card, FOREST, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-hellkite-v1';
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
        battlefield: [{ playerId: 'P1', cardNames: ['Steel Hellkite', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'hellkite-viewer-plus-one-power-until-eot',
      version: 1,
      title: 'Steel Hellkite: +1/+0 until end of turn',
      instructions: [
        'Activate Steel Hellkite\u2019s {2} ability using two Forests.',
        'Pass leftover {X} activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Steel Hellkite is a 6/5 until end of turn. Destroying mana-value X permanents after combat damage stays engine-only.',
      oracleSha256: hellkite.sha256,
      clauseIds: ['hellkite-plus-one-power-until-eot'],
    },
    seed,
    seats,
    engine,
  };
}

function rogueRefinerScenario(gameId: GameId): CardTestScenario {
  const refiner = pinnedFrom(LIVING_ENERGY_BATCH1, 'Rogue Refiner');
  const p1 = player('P1', [
    refiner.card,
    ISLAND,
    FOREST,
    FOREST,
    ELIGIBLE,
    ELIGIBLE_SIGNET,
    WRONG_MV,
  ]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-refiner-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Rogue Refiner'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'refiner-viewer-etb-draw-two-energy',
      version: 1,
      title: 'Rogue Refiner: draw a nonland and get two energy',
      instructions: [
        'Cast Rogue Refiner from your hand using the Island and two Forests.',
        'Pass priority so the enter trigger draws and grants energy.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome: 'You draw one nonland card and have two energy. Opponents do not draw.',
      oracleSha256: refiner.sha256,
      clauseIds: ['refiner-etb-draws-and-gains-two-energy'],
    },
    seed,
    seats,
    engine,
  };
}

function whirlerVirtuosoScenario(gameId: GameId): CardTestScenario {
  const virtuoso = pinnedFrom(LIVING_ENERGY_BATCH1, 'Whirler Virtuoso');
  const p1 = player('P1', [virtuoso.card, ISLAND, MOUNTAIN, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-virtuoso-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Whirler Virtuoso'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Mountain', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'virtuoso-viewer-energy-makes-thopter',
      version: 1,
      title: 'Whirler Virtuoso: three energy makes a Thopter',
      instructions: [
        'Cast Whirler Virtuoso from your hand using the Island, Mountain, and Forest.',
        'Pass priority so the enter trigger grants three energy.',
        'Activate the energy ability to create a Thopter.',
        'Pass leftover activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'A 1/1 flying Thopter is on the battlefield and you have no energy left. Two energy cannot make a Thopter; that case stays engine-only.',
      oracleSha256: virtuoso.sha256,
      clauseIds: ['virtuoso-etb-gains-three-energy-and-pays-three-for-a-thopter'],
    },
    seed,
    seats,
    engine,
  };
}

function ajaniCallerScenario(gameId: GameId): CardTestScenario {
  const ajani = pinnedFrom(TOKEN_TRIUMPH_BATCH3, 'Ajani, Caller of the Pride');
  const p1 = player('P1', [ajani.card, LAB_OX, PLAINS, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-ajani-v1';
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
        battlefield: [{ playerId: 'P1', cardNames: ['Ajani, Caller of the Pride', 'Lab Ox'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'ajani-viewer-plus-one-counter',
      version: 1,
      title: 'Ajani, Caller of the Pride: +1 counter on Lab Ox',
      instructions: [
        'Activate Ajani\u2019s +1 ability targeting Lab Ox.',
        'Pass leftover loyalty activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Lab Ox is a 5/5. Flying, double strike, and the Cat ultimate stay engine-only.',
      oracleSha256: ajani.sha256,
      clauseIds: ['ajani-plus-one-puts-a-counter-or-can-choose-none'],
    },
    seed,
    seats,
    engine,
  };
}

function terrorOfThePeaksScenario(gameId: GameId): CardTestScenario {
  const terror = pinnedFrom(W2_REMAINING_BATCH1, 'Terror of the Peaks');
  const p1 = player('P1', [terror.card, WRONG_TYPE, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-terror-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Two-Mana Bear'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Terror of the Peaks', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id: 'terror-viewer-etb-damage-to-player',
      version: 1,
      title: 'Terror of the Peaks: entering Bear deals 2 to P2',
      instructions: [
        'Cast Two-Mana Bear from your hand using two Forests.',
        'Target opponent P2 with Terror of the Peaks\u2019 enter trigger.',
        'Pass priority so 2 damage resolves.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'P2 loses 2 life. Terror itself did not deal damage when it entered; that case stays engine-only.',
      oracleSha256: terror.sha256,
      clauseIds: ['terror-deals-the-entering-creature-power-and-ignores-self-entry'],
    },
    seed,
    seats,
    engine,
  };
}

function aetherwindBaskerScenario(gameId: GameId): CardTestScenario {
  const basker = pinnedFrom(LIVING_ENERGY_BATCH1, 'Aetherwind Basker');
  const p1 = player('P1', [basker.card, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-basker-v1';
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
        hand: [{ playerId: 'P1', cardNames: ['Aetherwind Basker'] }],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
          },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'basker-viewer-plus-one-until-eot',
      version: 1,
      title: 'Aetherwind Basker: +1/+1 until end of turn',
      instructions: [
        'Cast Aetherwind Basker from your hand using seven Forests.',
        'Pass priority so the enter trigger grants one energy for itself.',
        'Activate the energy pump once.',
        'Pass leftover activations with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Aetherwind Basker is an 8/8 until end of turn. Opponent creatures do not grant energy; that case stays engine-only.',
      oracleSha256: basker.sha256,
      clauseIds: ['basker-pays-one-energy-to-pump-until-eot'],
    },
    seed,
    seats,
    engine,
  };
}

function zopandrelIndestructibleCounterScenario(gameId: GameId): CardTestScenario {
  const zopandrel = pinnedFrom(W2_REMAINING_BATCH1, 'Zopandrel, Hunger Dominus');
  const p1 = player('P1', [zopandrel.card, WRONG_TYPE, LAB_SHAMAN, FOREST, FOREST]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const seed = 'card-lab-zopandrel-indestructible-counter-v1';
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
          {
            playerId: 'P1',
            cardNames: [
              'Zopandrel, Hunger Dominus',
              'Two-Mana Bear',
              'Lab Shaman',
              'Forest',
              'Forest',
            ],
          },
        ],
      },
    },
  );
  return {
    metadata: {
      id: 'zopandrel-viewer-indestructible-counter',
      version: 1,
      title: 'Zopandrel: indestructible counter grants indestructible',
      instructions: [
        'Activate Zopandrel using two Forests and sacrifice the two other creatures.',
        'Pass priority so the activated ability resolves.',
        'Confirm that Zopandrel shows one indestructible counter and the indestructible keyword.',
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        'Zopandrel remains on the battlefield with one indestructible counter and indestructible in its public characteristics.',
      oracleSha256: zopandrel.sha256,
      clauseIds: ['zopandrel-indestructible-counter-grants-keyword-and-survives-lethal'],
    },
    seed,
    seats,
    engine,
  };
}

function arcaneDenialScenario(gameId: GameId, drawCount: 0 | 2): CardTestScenario {
  const arcane = pinnedFrom(MARCHESA_BATCH1, 'Arcane Denial');
  const p1 = player('P1', [arcane.card, ISLAND, FOREST, ARCANE_CASTER_SECRET]);
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [ARCANE_PENDING_SPELL, ARCANE_TARGET_SECRET_A, ARCANE_TARGET_SECRET_B]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = `arcane-denial-viewer-draw-${drawCount === 0 ? 'zero' : 'two'}`;
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 3,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Arcane Denial'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Forest'] }],
        graveyard: [],
        stack: [{ playerId: 'P4', cardNames: ['Lab Pending Spell'] }],
        continueToNextUpkeep: true,
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: `Arcane Denial: next-upkeep draw ${drawCount}`,
      instructions: [
        'Cast Arcane Denial targeting the prepared P4 spell and pay with Island and Forest.',
        'Pass priority so Arcane Denial resolves and counters the spell.',
        "At P2's immediately next upkeep, order the two simultaneous delayed triggers.",
        `As P4, choose to draw ${drawCount} cards; confirm P1 also draws one mandatory card.`,
      ],
      expectedOutcome: `Both delayed triggers fire at P2's upkeep; P4 draws ${drawCount} and P1 draws one without revealing card identities to other players.`,
      oracleSha256: arcane.sha256,
      clauseIds: [
        'arcane-denial-counter-and-affected-player-draw',
        'arcane-denial-caster-mandatory-draw',
      ],
    },
    seed,
    seats,
    engine,
    decisionProviderOverrides: {
      P4: new ScriptedDecisionProvider([choose(`Draw ${drawCount} cards`)]),
    },
  };
}

const arcaneDenialDrawZeroScenario = (gameId: GameId): CardTestScenario =>
  arcaneDenialScenario(gameId, 0);
const arcaneDenialDrawTwoScenario = (gameId: GameId): CardTestScenario =>
  arcaneDenialScenario(gameId, 2);

function smotheringTitheScenario(gameId: GameId, outcome: 'pay' | 'decline'): CardTestScenario {
  const tithe = pinnedFrom(MARCHESA_BATCH1, 'Smothering Tithe');
  const secret = card({
    oracleId: `lab-tithe-secret-${outcome}`,
    name: `Tithe Secret ${outcome === 'pay' ? 'Pay' : 'Decline'}`,
    typeLine: 'Creature — Secret',
  });
  const p1 = player('P1', [ARCANE_PENDING_SPELL, FOREST, FOREST, FOREST, secret]);
  const p2 = player('P2', [tithe.card, FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = `smothering-tithe-viewer-${outcome}`;
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Pending Spell'] }],
        battlefield: [
          { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest'] },
          { playerId: 'P2', cardNames: ['Smothering Tithe'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: `Smothering Tithe: opponent draws and ${outcome === 'pay' ? 'pays' : 'declines'}`,
      instructions: [
        'Cast Lab Pending Spell with one Forest and pass priority so it draws one card.',
        `When P2's Smothering Tithe trigger resolves, ${outcome === 'pay' ? 'pay {2} with the remaining Forests' : 'decline to pay {2}'}.`,
        'Pass with the stack empty to finish the scenario.',
      ],
      expectedOutcome:
        outcome === 'pay'
          ? 'P1 draws one card and pays {2}; P2 creates no Treasure.'
          : 'P1 draws one card and declines {2}; P2 creates exactly one Treasure.',
      oracleSha256: tithe.sha256,
      clauseIds: ['smothering-tithe-opponent-draw-tax'],
    },
    seed,
    seats,
    engine,
  };
}

const smotheringTithePayScenario = (gameId: GameId): CardTestScenario =>
  smotheringTitheScenario(gameId, 'pay');
const smotheringTitheDeclineScenario = (gameId: GameId): CardTestScenario =>
  smotheringTitheScenario(gameId, 'decline');

function fabledPassageScenario(gameId: GameId): CardTestScenario {
  const passage = pinnedFrom(MARCHESA_BATCH1, 'Fabled Passage');
  const secret = card({
    oracleId: 'lab-fabled-secret',
    name: 'Fabled Private Library Secret',
    typeLine: 'Creature — Secret',
  });
  const p1 = player('P1', [passage.card, FOREST, FOREST, FOREST, ISLAND, secret]);
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = 'fabled-passage-viewer-search-entry-untap';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
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
          { playerId: 'P1', cardNames: ['Fabled Passage', 'Forest', 'Forest', 'Forest'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Fabled Passage: search, tapped entry, and fourth-land untap',
      instructions: [
        'Activate Fabled Passage through the normal action menu, paying tap and sacrifice.',
        'Choose Island from the private library search and let the ability resolve.',
        'Verify the found Island enters and is untapped because it is your fourth land.',
      ],
      expectedOutcome:
        'Fabled Passage is in the graveyard, the searched Island is the fourth land and untapped, and other library cards remain private.',
      oracleSha256: passage.sha256,
      clauseIds: ['fabled-passage-search-entry-untap'],
    },
    seed,
    seats,
    engine,
  };
}

function myriadLandscapeEntryScenario(gameId: GameId): CardTestScenario {
  const landscape = pinnedFrom(MARCHESA_BATCH1, 'Myriad Landscape');
  const p1 = player('P1', [landscape.card, FOREST]);
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = 'myriad-landscape-viewer-enters-tapped';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 1,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Myriad Landscape'] }],
        battlefield: [],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Myriad Landscape: normal land play enters tapped',
      instructions: [
        'Play Myriad Landscape from hand through the normal land action.',
        'Verify it enters tapped rather than creating a stack object.',
      ],
      expectedOutcome: 'Myriad Landscape is on the battlefield tapped after the normal land play.',
      oracleSha256: landscape.sha256,
      clauseIds: ['myriad-landscape-enters-tapped'],
    },
    seed,
    seats,
    engine,
  };
}

function myriadLandscapeSearchScenario(gameId: GameId): CardTestScenario {
  const landscape = pinnedFrom(MARCHESA_BATCH1, 'Myriad Landscape');
  const sharedDual = card({
    oracleId: 'lab-myriad-shared-dual',
    name: 'Myriad Shared Dual',
    typeLine: 'Basic Land — Plains Island',
  });
  const secret = card({
    oracleId: 'lab-myriad-secret',
    name: 'Myriad Private Library Secret',
    typeLine: 'Creature — Secret',
  });
  const p1 = player('P1', [landscape.card, FOREST, FOREST, ISLAND, sharedDual, secret]);
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = 'myriad-landscape-viewer-shared-type-search';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [{ playerId: 'P1', cardNames: ['Myriad Landscape', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Myriad Landscape: shared land type grouped search',
      instructions: [
        'Activate Myriad Landscape through the normal action menu and pay {2} with both Forests.',
        'Choose Island and Myriad Shared Dual together from the private grouped search.',
        'Verify both found lands enter tapped and the unrelated private card remains hidden.',
      ],
      expectedOutcome:
        'Myriad Landscape is sacrificed, both mana lands are tapped, and the two Island-sharing basics enter tapped.',
      oracleSha256: landscape.sha256,
      clauseIds: ['myriad-landscape-colorless-mana', 'myriad-landscape-shared-land-type-search'],
    },
    seed,
    seats,
    engine,
  };
}

function myriadLandscapeManaScenario(gameId: GameId): CardTestScenario {
  const landscape = pinnedFrom(MARCHESA_BATCH1, 'Myriad Landscape');
  const manaSink = card({
    oracleId: 'lab-myriad-mana-sink',
    name: 'Myriad Mana Sink',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
  });
  const p1 = player('P1', [landscape.card, manaSink]);
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = 'myriad-landscape-viewer-colorless-mana';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 1,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Myriad Mana Sink'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Myriad Landscape'] }],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Myriad Landscape: colorless mana pays a spell cost',
      instructions: [
        'Cast Myriad Mana Sink from hand through the normal spell action.',
        'Verify the mana solver taps Myriad Landscape for {C} to pay the generic cost.',
      ],
      expectedOutcome:
        'Myriad Landscape is tapped for mana and Myriad Mana Sink resolves onto the battlefield.',
      oracleSha256: landscape.sha256,
      clauseIds: ['myriad-landscape-colorless-mana'],
    },
    seed,
    seats,
    engine,
  };
}

function warRoomManaScenario(gameId: GameId): CardTestScenario {
  const warRoom = pinnedFrom(MARCHESA_BATCH1, 'War Room');
  const manaSink = card({
    oracleId: 'lab-war-room-mana-sink',
    name: 'War Room Mana Sink',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
  });
  const p1 = player('P1', [warRoom.card, manaSink]);
  const others = (['P2', 'P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST]));
  const seats = [p1.setup, ...others.map(({ setup }) => setup)];
  const id = 'war-room-viewer-colorless-mana';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, ...others.map(({ config }) => config)],
      turnCap: 1,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['War Room Mana Sink'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['War Room'] }],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'War Room: colorless mana pays a spell cost',
      instructions: [
        'Cast War Room Mana Sink from hand through the normal spell action.',
        'Verify the mana solver taps War Room for {C} to pay the generic {1} cost.',
        'After forced passes resolve the artifact, close results and confirm life stays 40 and no card is drawn.',
      ],
      expectedOutcome:
        'War Room is tapped, War Room Mana Sink resolves onto the battlefield, life stays 40, and no card is drawn.',
      oracleSha256: warRoom.sha256,
      clauseIds: ['war-room-colorless-mana'],
    },
    seed,
    seats,
    engine,
  };
}

function warRoomScenario(gameId: GameId): CardTestScenario {
  const warRoom = pinnedFrom(MARCHESA_BATCH1, 'War Room');
  const commander = card({
    oracleId: 'lab-war-room-commander',
    name: 'Three Color Commander',
    typeLine: 'Legendary Creature — Test Captain',
    colorIdentity: ['W', 'U', 'B'],
    colors: ['W', 'U', 'B'],
  });
  const sink = card({
    oracleId: 'lab-war-room-sink',
    name: 'War Room Mana Sink',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
  });
  const witness = card({
    oracleId: 'lab-war-room-action-witness',
    name: 'War Room Action Witness',
    typeLine: 'Artifact',
    manaCost: '{0}',
    cmc: 0,
  });
  const p1 = player('P1', [warRoom.card, sink, witness, commander, FOREST, FOREST, FOREST]);
  p1.config.commanders = [commander];
  const p2 = player('P2', [FOREST, FOREST]);
  const p3 = player('P3', [FOREST, FOREST]);
  const p4 = player('P4', [FOREST, FOREST]);
  const seats = [p1.setup, p2.setup, p3.setup, p4.setup];
  const id = 'war-room-viewer-dynamic-life-activation';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, p3.config, p4.config],
      turnCap: 2,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['War Room Mana Sink', 'War Room Action Witness'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['War Room', 'Forest', 'Forest', 'Forest'] }],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'War Room: dynamic commander-identity life activation',
      instructions: [
        'Activate War Room through the normal action menu, paying {3} with the three Forests.',
        'Verify the cost shows three life for the three-color commander identity and resolve the draw.',
        'Pass only when offered a legal priority action; confirm the resolved draw with the zero-cost witness still in hand.',
      ],
      expectedOutcome:
        'War Room and all three Forests tap, its controller pays exactly three life, and draws Three Color Commander.',
      oracleSha256: warRoom.sha256,
      // Paying {3} taps every Forest AND War Room, so this scenario cannot also demonstrate the
      // mana clause — `war-room-viewer-colorless-mana` carries that evidence.
      clauseIds: ['war-room-dynamic-life-draw'],
    },
    seed,
    seats,
    engine,
  };
}

// ---------------------------------------------------------------------------------------------
// Coverage PR01 (docs/plans/card-coverage-chunks.md): one scenario per restored clause group.
// ---------------------------------------------------------------------------------------------

interface Pr01ScenarioSpec {
  id: string;
  title: string;
  instructions: string[];
  expectedOutcome: string;
  oracleSha256: string;
  clauseIds: string[];
  /** Library contents per seat; prepared hand/battlefield/graveyard cards are drawn from these. */
  decks: Record<'P1' | 'P2' | 'P3' | 'P4', OracleCard[]>;
  prepared: Omit<PreparedScenarioSpec, 'currentTurnPlayer' | 'phase' | 'step' | 'turnNumber'> &
    Partial<Pick<PreparedScenarioSpec, 'currentTurnPlayer' | 'phase' | 'step' | 'turnNumber'>>;
  decisionProviderOverrides?: CardTestScenario['decisionProviderOverrides'];
}

function pr01Scenario(gameId: GameId, spec: Pr01ScenarioSpec): CardTestScenario {
  const seats = (['P1', 'P2', 'P3', 'P4'] as const).map((id) => player(id, spec.decks[id]));
  const seed = `card-lab-${spec.id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: seats.map(({ config }) => config), turnCap: 2 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        ...spec.prepared,
      },
    },
  );
  return {
    metadata: {
      id: spec.id,
      version: 1,
      title: spec.title,
      instructions: spec.instructions,
      expectedOutcome: spec.expectedOutcome,
      oracleSha256: spec.oracleSha256,
      clauseIds: spec.clauseIds,
    },
    seed,
    seats: seats.map(({ setup }) => setup),
    engine,
    ...(spec.decisionProviderOverrides === undefined
      ? {}
      : { decisionProviderOverrides: spec.decisionProviderOverrides }),
  };
}

const PR01_FILLER = [FOREST, FOREST];

function forumOfAmityScenario(gameId: GameId): CardTestScenario {
  const forum = pinnedFrom(MARCHESA_BATCH1, 'Forum of Amity');
  const surveilled = card({
    oracleId: 'lab-forum-surveilled',
    name: 'Forum Surveilled Card',
    typeLine: 'Creature — Secret',
  });
  return pr01Scenario(gameId, {
    id: 'forum-of-amity-viewer-surveil',
    title: 'Forum of Amity: surveil 1 through the normal activation',
    instructions: [
      'Activate Forum of Amity, paying {2}{W}{B} from Plains, Swamp, and two Forests plus tapping it.',
      'Let the ability resolve, then choose to put the surveilled card into your graveyard.',
    ],
    expectedOutcome:
      'Forum of Amity and the four paying lands are tapped, and Forum Surveilled Card moves from the top of your library to your graveyard.',
    oracleSha256: forum.sha256,
    clauseIds: ['forum-of-amity-surveil-activation'],
    decks: {
      P1: [forum.card, PLAINS, SWAMP, FOREST, FOREST, surveilled],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Forum of Amity', 'Plains', 'Swamp', 'Forest', 'Forest'],
        },
      ],
    },
  });
}

function attuneWithAetherScenario(gameId: GameId): CardTestScenario {
  const attune = pinnedFrom(MARCHESA_BATCH1, 'Attune with Aether');
  const secret = card({
    oracleId: 'lab-attune-secret',
    name: 'Attune Private Library Secret',
    typeLine: 'Creature — Secret',
  });
  return pr01Scenario(gameId, {
    id: 'attune-with-aether-viewer-reveal-to-hand',
    title: 'Attune with Aether: reveal a basic land, then get two energy',
    instructions: [
      'Cast Attune with Aether from your hand using your Forest.',
      'Choose the Island from the library search and let the spell resolve.',
    ],
    expectedOutcome:
      'The Island is revealed to every player and put into your hand, your library is shuffled, you have two energy, and other library cards stay private.',
    oracleSha256: attune.sha256,
    clauseIds: ['attune-with-aether-search-reveal-energy'],
    decks: {
      P1: [attune.card, FOREST, ISLAND, secret],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Attune with Aether'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Forest'] }],
    },
  });
}

function beaconOfUnrestScenario(gameId: GameId): CardTestScenario {
  const beacon = pinnedFrom(MARCHESA_BATCH1, 'Beacon of Unrest');
  return pr01Scenario(gameId, {
    id: 'beacon-of-unrest-viewer-reanimate-and-shuffle',
    title: 'Beacon of Unrest: reanimate a creature card, shuffle Beacon away',
    instructions: [
      'Cast Beacon of Unrest from your hand with your five lands.',
      'Target Lab Ox in your graveyard and let the spell resolve.',
    ],
    expectedOutcome:
      'Lab Ox returns to the battlefield under your control, and Beacon of Unrest is shuffled into your library instead of going to your graveyard.',
    oracleSha256: beacon.sha256,
    clauseIds: ['beacon-of-unrest-reanimate', 'beacon-of-unrest-shuffle-self'],
    decks: {
      P1: [beacon.card, SWAMP, SWAMP, FOREST, FOREST, FOREST, LAB_OX],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Beacon of Unrest'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Forest', 'Forest', 'Forest'] },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Ox'] }],
    },
  });
}

function canoptekSpyderScenario(gameId: GameId): CardTestScenario {
  const spyder = pinnedFrom(MARCHESA_BATCH1, 'Canoptek Spyder');
  const vehicle = card({
    oracleId: 'lab-spyder-vehicle',
    name: 'Lab Skiff',
    typeLine: 'Artifact — Vehicle',
    manaCost: '{1}',
    cmc: 1,
  });
  const drawn = card({
    oracleId: 'lab-spyder-drawn',
    name: 'Spyder Drawn Card',
    typeLine: 'Creature — Secret',
    manaCost: '{6}',
    cmc: 6,
  });
  return pr01Scenario(gameId, {
    id: 'canoptek-spyder-viewer-vehicle-draw',
    title: 'Canoptek Spyder: a Vehicle entering draws a card',
    instructions: [
      'Cast Lab Skiff, a noncreature artifact Vehicle, from your hand with your Forest.',
      "Let it resolve so Canoptek Spyder's Fabricator Claw Array triggers, then let the trigger resolve.",
    ],
    expectedOutcome:
      'Lab Skiff enters, the Spyder trigger resolves, and you draw Spyder Drawn Card from the top of your library.',
    oracleSha256: spyder.sha256,
    clauseIds: ['canoptek-spyder-artifact-creature-or-vehicle-draw'],
    decks: {
      P1: [spyder.card, vehicle, FOREST, drawn],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Skiff'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Canoptek Spyder', 'Forest'] }],
    },
  });
}

/** Historical five-card review batch; later independently reviewed cards use separate evidence. */
export const REVIEWED_BASELINE_SCENARIO_IDS = [
  'tribute-viewer-cast-search-select-resolve',
  'gev-viewer-opponent-targets-ward',
  'nightscape-viewer-activate-regenerate-destroy',
  'thran-viewer-graveyard-departure-trigger',
  'harmonic-viewer-cast-and-double-trigger',
] as const;

export const CARD_TEST_SCENARIO_IDS = [
  ...REVIEWED_BASELINE_SCENARIO_IDS,
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
  'slate-viewer-discard-and-draw-for-creatures',
  'scarab-viewer-exile-graveyard-make-insects',
  'oak-viewer-pump-and-untap-target-player',
  'frostboil-viewer-reveal-enters-untapped',
  'vineglimmer-viewer-reveal-enters-untapped',
  'stroke-viewer-destroy-nonland-make-human',
  'gift-viewer-destroy-and-make-elephant',
  'garrison-viewer-bounce-forest-enters-tapped',
  'basilica-viewer-bounce-forest-enters-tapped',
  'pia-kiran-viewer-etb-two-thopters',
  'crackling-viewer-damage-and-greatest-sacrifice',
  'carnarium-viewer-bounce-forest-enters-tapped',
  'whirler-viewer-etb-two-thopters',
  'weaver-viewer-artifact-etb-pings-opponents',
  'spit-viewer-four-damage-to-ox',
  'sai-viewer-cast-artifact-makes-thopter',
  'rendezvous-viewer-you-and-opponent-draw-three',
  'demanding-viewer-five-damage-no-creature',
  'cryptothrall-viewer-hexproof-other-artifact-creatures',
  'boros-charm-viewer-four-damage-to-player',
  'rakdos-charm-viewer-destroy-artifact',
  'hellkite-viewer-plus-one-power-until-eot',
  'refiner-viewer-etb-draw-two-energy',
  'virtuoso-viewer-energy-makes-thopter',
  'ajani-viewer-plus-one-counter',
  'terror-viewer-etb-damage-to-player',
  'basker-viewer-plus-one-until-eot',
  'zopandrel-viewer-indestructible-counter',
  'arcane-denial-viewer-draw-zero',
  'arcane-denial-viewer-draw-two',
  'smothering-tithe-viewer-pay',
  'smothering-tithe-viewer-decline',
  'fabled-passage-viewer-search-entry-untap',
  'myriad-landscape-viewer-enters-tapped',
  'myriad-landscape-viewer-colorless-mana',
  'myriad-landscape-viewer-shared-type-search',
  'war-room-viewer-dynamic-life-activation',
  'war-room-viewer-colorless-mana',
  // Coverage PR01
  'forum-of-amity-viewer-surveil',
  'attune-with-aether-viewer-reveal-to-hand',
  'beacon-of-unrest-viewer-reanimate-and-shuffle',
  'canoptek-spyder-viewer-vehicle-draw',
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
  'slate-viewer-discard-and-draw-for-creatures': slateScenario,
  'scarab-viewer-exile-graveyard-make-insects': scarabScenario,
  'oak-viewer-pump-and-untap-target-player': oakScenario,
  'frostboil-viewer-reveal-enters-untapped': frostboilScenario,
  'vineglimmer-viewer-reveal-enters-untapped': vineglimmerScenario,
  'stroke-viewer-destroy-nonland-make-human': strokeScenario,
  'gift-viewer-destroy-and-make-elephant': giftScenario,
  'garrison-viewer-bounce-forest-enters-tapped': garrisonScenario,
  'basilica-viewer-bounce-forest-enters-tapped': basilicaScenario,
  'pia-kiran-viewer-etb-two-thopters': piaKiranScenario,
  'crackling-viewer-damage-and-greatest-sacrifice': cracklingScenario,
  'carnarium-viewer-bounce-forest-enters-tapped': carnariumScenario,
  'whirler-viewer-etb-two-thopters': whirlerScenario,
  'weaver-viewer-artifact-etb-pings-opponents': weaverScenario,
  'spit-viewer-four-damage-to-ox': spitFlameScenario,
  'sai-viewer-cast-artifact-makes-thopter': saiScenario,
  'rendezvous-viewer-you-and-opponent-draw-three': rendezvousScenario,
  'demanding-viewer-five-damage-no-creature': demandingDragonScenario,
  'cryptothrall-viewer-hexproof-other-artifact-creatures': cryptothrallScenario,
  'boros-charm-viewer-four-damage-to-player': borosCharmScenario,
  'rakdos-charm-viewer-destroy-artifact': rakdosCharmScenario,
  'hellkite-viewer-plus-one-power-until-eot': steelHellkiteScenario,
  'refiner-viewer-etb-draw-two-energy': rogueRefinerScenario,
  'virtuoso-viewer-energy-makes-thopter': whirlerVirtuosoScenario,
  'ajani-viewer-plus-one-counter': ajaniCallerScenario,
  'terror-viewer-etb-damage-to-player': terrorOfThePeaksScenario,
  'basker-viewer-plus-one-until-eot': aetherwindBaskerScenario,
  'zopandrel-viewer-indestructible-counter': zopandrelIndestructibleCounterScenario,
  'arcane-denial-viewer-draw-zero': arcaneDenialDrawZeroScenario,
  'arcane-denial-viewer-draw-two': arcaneDenialDrawTwoScenario,
  'smothering-tithe-viewer-pay': smotheringTithePayScenario,
  'smothering-tithe-viewer-decline': smotheringTitheDeclineScenario,
  'fabled-passage-viewer-search-entry-untap': fabledPassageScenario,
  'myriad-landscape-viewer-enters-tapped': myriadLandscapeEntryScenario,
  'myriad-landscape-viewer-colorless-mana': myriadLandscapeManaScenario,
  'myriad-landscape-viewer-shared-type-search': myriadLandscapeSearchScenario,
  'war-room-viewer-dynamic-life-activation': warRoomScenario,
  'war-room-viewer-colorless-mana': warRoomManaScenario,
  'forum-of-amity-viewer-surveil': forumOfAmityScenario,
  'attune-with-aether-viewer-reveal-to-hand': attuneWithAetherScenario,
  'beacon-of-unrest-viewer-reanimate-and-shuffle': beaconOfUnrestScenario,
  'canoptek-spyder-viewer-vehicle-draw': canoptekSpyderScenario,
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
