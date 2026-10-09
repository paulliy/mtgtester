import { SPELL_FACE_SCENARIO_IDS, spellFaceScenario } from './spell-face-scenarios';
import {
  SPECIALIZED_REFERENCE_SCENARIO_IDS,
  specializedReferenceScenario,
} from './specialized-reference-scenarios';
import {
  ZONE_CHANGE_TRIGGER_SCENARIO_IDS,
  zoneChangeTriggerScenario,
} from './zone-change-trigger-scenarios';
import {
  COUNTER_OVERLOAD_SCENARIO_IDS,
  counterOverloadScenario,
} from './counter-overload-scenarios';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { choose, Engine, ScriptedDecisionProvider } from '@mtg/engine';
import type { DecisionProvider, EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { CardTestScenarioMetadata, Color, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { SeatSetup } from '../match/setup';
import { BUG_HUNT_SCENARIO_IDS, bugHuntScenario } from './bug-hunt-scenarios';
import { TARGET_UNTAP_SCENARIO_IDS, targetUntapScenario } from './target-untap-scenarios';

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
/** Coverage PR01 cards that had no earlier pinned fixture. */
const COVERAGE_PR01: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/coverage-pr01-oracle.json'), 'utf8'),
) as PinnedOracleFile;

/** Coverage PR02 cards that had no earlier pinned fixture. */
const COVERAGE_PR02: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/coverage-pr02-oracle.json'), 'utf8'),
) as PinnedOracleFile;

/** Coverage PR03 cards that had no earlier pinned fixture. */
const COVERAGE_PR03: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/coverage-pr03-oracle.json'), 'utf8'),
) as PinnedOracleFile;

const HIDEAWAY_CASTING: PinnedOracleFile = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/hideaway-casting-oracle.json'), 'utf8'),
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
    // This synthetic spell keeps a priority choice available after all three Forests tap.
    manaCost: '{0}',
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

/** Exercises public-zone targeting through the existing Reanimate grammar, without an override. */
function opponentGraveyardScenario(gameId: GameId): CardTestScenario {
  const reanimation = card({
    oracleId: 'lab-reanimation',
    name: 'Lab Reanimation',
    typeLine: 'Sorcery',
    manaCost: '{B}',
    cmc: 1,
    colors: ['B'],
    oracleText:
      "Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card's mana value.",
  });
  const p1 = player('P1', [reanimation, SWAMP, LAB_SERVO]);
  const p2 = player('P2', [LAB_OX, ELIGIBLE_SIGNET, FOREST]);
  const others = (['P3', 'P4'] as const).map((id) => player(id, [FOREST, FOREST]));
  const seats = [p1.setup, p2.setup, ...others.map(({ setup }) => setup)];
  const id = 'opponent-graveyard-viewer-reanimate';
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    {
      gameId,
      seed,
      players: [p1.config, p2.config, ...others.map(({ config }) => config)],
      turnCap: 1,
    },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [{ playerId: 'P1', cardNames: ['Lab Reanimation'] }],
        battlefield: [{ playerId: 'P1', cardNames: ['Swamp'] }],
        graveyard: [
          { playerId: 'P1', cardNames: ['Lab Servo'] },
          { playerId: 'P2', cardNames: ['Eligible Signet', 'Lab Ox'] },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: 'Public zones: reanimate an opponent’s creature',
      instructions: [
        'Cast Lab Reanimation from hand.',
        'Click the highlighted Lab Ox in P2’s graveyard strip and confirm the spell.',
      ],
      expectedOutcome:
        'Lab Ox leaves P2’s graveyard and enters under P1’s control; P1 loses 4 life. Eligible Signet cannot be selected.',
      oracleSha256: createHash('sha256').update(JSON.stringify(reanimation)).digest('hex'),
      clauseIds: ['opponent-graveyard-target-selection'],
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
  /** Commanders per seat; they start in the command zone unless `prepared` places them. */
  commanders?: Partial<Record<'P1' | 'P2' | 'P3' | 'P4', OracleCard[]>>;
  prepared: Omit<PreparedScenarioSpec, 'currentTurnPlayer' | 'phase' | 'step' | 'turnNumber'> &
    Partial<Pick<PreparedScenarioSpec, 'currentTurnPlayer' | 'phase' | 'step' | 'turnNumber'>>;
  decisionProviderOverrides?: CardTestScenario['decisionProviderOverrides'];
}

function pr01Scenario(gameId: GameId, spec: Pr01ScenarioSpec): CardTestScenario {
  const seats = (['P1', 'P2', 'P3', 'P4'] as const).map((id) => {
    const seat = player(id, spec.decks[id]);
    const commanders = spec.commanders?.[id] ?? [];
    seat.config.commanders = commanders;
    seat.setup.summary.commanderNames = commanders.map((commander) => commander.name);
    return seat;
  });
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

function canoptekWraithScenario(gameId: GameId): CardTestScenario {
  const wraith = pinnedFrom(MARCHESA_BATCH1, 'Canoptek Wraith');
  return pr01Scenario(gameId, {
    id: 'canoptek-wraith-viewer-scout-same-name-search',
    title: 'Canoptek Wraith: pay, sacrifice, and fetch same-name basics',
    instructions: [
      'Pass priority to move to combat, then attack P2 with Canoptek Wraith (it cannot be blocked).',
      'When it deals combat damage, pay {3} and sacrifice it, choose Island, and find two Islands.',
    ],
    expectedOutcome:
      'Canoptek Wraith is in your graveyard, two Islands from your library entered tapped, the Forest stayed in your library, and your library was shuffled.',
    oracleSha256: wraith.sha256,
    clauseIds: ['canoptek-wraith-unblockable', 'canoptek-wraith-scout-search'],
    decks: {
      P1: [wraith.card, ISLAND, ISLAND, ISLAND, FOREST, ISLAND, ISLAND, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Canoptek Wraith', 'Island', 'Island', 'Island', 'Forest'] },
      ],
      continueThroughCombat: true,
    },
  });
}

function conjurersClosetScenario(gameId: GameId): CardTestScenario {
  const closet = pinnedFrom(MARCHESA_BATCH1, "Conjurer's Closet");
  const greeter = card({
    oracleId: 'lab-closet-greeter',
    name: 'Lab Greeter',
    typeLine: 'Creature — Human',
    manaCost: '{2}',
    cmc: 2,
    power: '2',
    toughness: '2',
    oracleText: 'When this creature enters, you gain 2 life.',
  });
  return pr01Scenario(gameId, {
    id: 'conjurers-closet-viewer-end-step-blink',
    title: "Conjurer's Closet: blink a creature at your end step",
    instructions: [
      'Pass priority in your main phase; the lab moves to your end step.',
      "Target Lab Greeter with Conjurer's Closet's trigger and choose Yes when it resolves.",
    ],
    expectedOutcome:
      'Lab Greeter is exiled and returns untapped under your control, and its enters trigger gains you 2 life (40 to 42).',
    oracleSha256: closet.sha256,
    clauseIds: ['conjurers-closet-end-step-blink'],
    decks: {
      P1: [closet.card, greeter, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ["Conjurer's Closet"] },
        { playerId: 'P1', cardNames: ['Lab Greeter'], tapped: true },
      ],
      continueToEndStep: true,
    },
  });
}

function harvestSeasonScenario(gameId: GameId): CardTestScenario {
  const harvest = pinnedFrom(MARCHESA_BATCH1, 'Harvest Season');
  return pr01Scenario(gameId, {
    id: 'harvest-season-viewer-tapped-creature-count',
    title: 'Harvest Season: search a basic per tapped creature',
    instructions: [
      'Cast Harvest Season with your three untapped Forests.',
      'You control two tapped Lab Oxen and one untapped Lab Servo, so X is 2: put an Island and a Plains onto the battlefield tapped.',
    ],
    expectedOutcome:
      'Exactly two searches are offered; the Island and Plains enter tapped, the untapped Lab Servo did not count, and your library is shuffled.',
    oracleSha256: harvest.sha256,
    clauseIds: ['harvest-season-search-x-tapped-creatures'],
    decks: {
      P1: [harvest.card, LAB_OX, LAB_OX, LAB_SERVO, FOREST, FOREST, FOREST, ISLAND, PLAINS, SWAMP],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Harvest Season'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Ox', 'Lab Ox'], tapped: true },
        { playerId: 'P1', cardNames: ['Lab Servo', 'Forest', 'Forest', 'Forest'] },
      ],
    },
  });
}

function landTaxScenario(gameId: GameId): CardTestScenario {
  const tax = pinnedFrom(MARCHESA_BATCH1, 'Land Tax');
  const secret = card({
    oracleId: 'lab-land-tax-secret',
    name: 'Land Tax Private Secret',
    typeLine: 'Creature — Secret',
    manaCost: '{6}',
    cmc: 6,
  });
  return pr01Scenario(gameId, {
    id: 'land-tax-viewer-upkeep-reveal-search',
    title: 'Land Tax: reveal three basics at your upkeep',
    instructions: [
      "Pass through P4's turn; Land Tax triggers at your upkeep because P2 controls more lands than you.",
      'Choose Yes, then put Plains, Swamp, and Island into your hand.',
    ],
    expectedOutcome:
      'Three basic lands are revealed to every player and put into your hand, your library is shuffled, and the private library card stays hidden.',
    oracleSha256: tax.sha256,
    clauseIds: ['land-tax-upkeep-search'],
    decks: {
      P1: [tax.card, FOREST, PLAINS, SWAMP, ISLAND, secret],
      P2: [FOREST, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      currentTurnPlayer: 'P4',
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Land Tax', 'Forest'] },
        { playerId: 'P2', cardNames: ['Forest', 'Forest', 'Forest'] },
      ],
      continueToNextUpkeep: true,
    },
  });
}

function mordantDragonScenario(gameId: GameId): CardTestScenario {
  const dragon = pinnedFrom(MARCHESA_BATCH1, 'Mordant Dragon');
  return pr01Scenario(gameId, {
    id: 'mordant-dragon-viewer-combat-damage-redirect',
    title: "Mordant Dragon: redirect combat damage to that player's creature",
    instructions: [
      'Attack P2 with Mordant Dragon; P2 has no flyer to block it.',
      'When it deals combat damage, target Lab Ox (P2 controls it) and choose Yes.',
    ],
    expectedOutcome:
      'P2 takes 5 combat damage (40 to 35), then Mordant Dragon deals 5 damage to Lab Ox, which dies; Lab Servo is untouched.',
    oracleSha256: dragon.sha256,
    clauseIds: ['mordant-dragon-combat-damage-rider'],
    decks: {
      P1: [dragon.card, FOREST],
      P2: [LAB_OX, LAB_SERVO, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Mordant Dragon'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
      ],
      continueThroughCombat: true,
    },
  });
}

function necronDeathmarkScenario(gameId: GameId): CardTestScenario {
  const deathmark = pinnedFrom(MARCHESA_BATCH1, 'Necron Deathmark');
  const bystander = card({
    oracleId: 'lab-deathmark-bystander',
    name: 'Lab Deathmark Bystander',
    typeLine: 'Creature — Human',
    manaCost: '{B}',
    cmc: 1,
    colors: ['B'],
    colorIdentity: ['B'],
    power: '1',
    toughness: '1',
  });
  return pr01Scenario(gameId, {
    id: 'necron-deathmark-viewer-destroy-up-to-one-and-mill',
    title: 'Necron Deathmark: destroy up to one creature, mill three',
    instructions: [
      "P3's Lab Pending Spell is on the stack, so only a spell with flash can be cast; Lab Deathmark Bystander cannot.",
      'Cast Necron Deathmark in response (flash) with your five lands.',
      'Target P2 for the mill and Lab Ox as the up-to-one creature, then let the trigger resolve.',
    ],
    expectedOutcome:
      'Lab Ox is destroyed and P2 mills three cards; Lab Servo survives because only one creature may be chosen. Lab Deathmark Bystander stays in your hand.',
    oracleSha256: deathmark.sha256,
    clauseIds: ['necron-deathmark-flash', 'necron-deathmark-destroy-and-mill'],
    decks: {
      P1: [deathmark.card, bystander, SWAMP, SWAMP, SWAMP, SWAMP, SWAMP],
      P2: [LAB_OX, LAB_SERVO, FOREST, FOREST, FOREST, FOREST],
      P3: [ARCANE_PENDING_SPELL, FOREST, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Necron Deathmark', 'Lab Deathmark Bystander'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
      ],
      stack: [{ playerId: 'P3', cardNames: ['Lab Pending Spell'] }],
    },
  });
}

function plasmancerScenario(gameId: GameId): CardTestScenario {
  const plasmancer = pinnedFrom(MARCHESA_BATCH1, 'Plasmancer');
  const secret = card({
    oracleId: 'lab-plasmancer-secret',
    name: 'Plasmancer Private Library Secret',
    typeLine: 'Creature — Secret',
  });
  return pr01Scenario(gameId, {
    id: 'plasmancer-viewer-reveal-swamp',
    title: 'Plasmancer: enters and reveals a basic Swamp',
    instructions: [
      'Cast Plasmancer with your four Swamps.',
      'When its enters trigger resolves, choose the Swamp from the library search.',
    ],
    expectedOutcome:
      'The Swamp is revealed to every player and put into your hand, your library is shuffled, the Forest is never offered, and other library cards stay private.',
    oracleSha256: plasmancer.sha256,
    clauseIds: ['plasmancer-enters-reveal-swamp'],
    decks: {
      P1: [plasmancer.card, SWAMP, SWAMP, SWAMP, SWAMP, SWAMP, FOREST, secret],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Plasmancer'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Swamp', 'Swamp'] }],
    },
  });
}

function sylvanReclamationScenario(gameId: GameId): CardTestScenario {
  const reclamation = pinnedFrom(MARCHESA_BATCH1, 'Sylvan Reclamation');
  const idol = card({
    oracleId: 'lab-reclaim-idol',
    name: 'Lab Idol',
    typeLine: 'Artifact',
    manaCost: '{2}',
    cmc: 2,
  });
  return pr01Scenario(gameId, {
    id: 'sylvan-reclamation-viewer-exile-up-to-two',
    title: 'Sylvan Reclamation: exile up to two artifacts and/or enchantments',
    instructions: [
      'Cast Sylvan Reclamation with your five lands.',
      'Choose Lab Servo and Lab Hex as its two targets, then let it resolve.',
    ],
    expectedOutcome:
      'Lab Servo and Lab Hex are exiled. No third target is offered, so Lab Idol survives, and Lab Ox is never offered because it is neither an artifact nor an enchantment.',
    oracleSha256: reclamation.sha256,
    clauseIds: ['sylvan-reclamation-exile-up-to-two'],
    decks: {
      P1: [reclamation.card, FOREST, FOREST, FOREST, FOREST, PLAINS],
      P2: [LAB_SERVO, LAB_HEX, LAB_OX, FOREST, FOREST],
      P3: [idol, FOREST, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Sylvan Reclamation'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Plains'] },
        { playerId: 'P2', cardNames: ['Lab Servo', 'Lab Hex', 'Lab Ox'] },
        { playerId: 'P3', cardNames: ['Lab Idol'] },
      ],
    },
  });
}

function sylvanReclamationLandcyclingScenario(gameId: GameId): CardTestScenario {
  const reclamation = pinnedFrom(MARCHESA_BATCH1, 'Sylvan Reclamation');
  const secret = card({
    oracleId: 'lab-reclaim-secret',
    name: 'Reclamation Private Library Secret',
    typeLine: 'Creature — Secret',
  });
  return pr01Scenario(gameId, {
    id: 'sylvan-reclamation-viewer-basic-landcycling',
    title: 'Sylvan Reclamation: basic landcycling reveals a basic land',
    instructions: [
      "Activate Sylvan Reclamation's basic landcycling from your hand with two Forests.",
      'Choose the Plains from the library search.',
    ],
    expectedOutcome:
      'Sylvan Reclamation is discarded, the Plains is revealed to every player and put into your hand, your library is shuffled, and other library cards stay private.',
    oracleSha256: reclamation.sha256,
    clauseIds: ['sylvan-reclamation-basic-landcycling'],
    decks: {
      P1: [reclamation.card, FOREST, FOREST, PLAINS, secret],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Sylvan Reclamation'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest'] }],
    },
  });
}

function thunderfootBalothScenario(gameId: GameId): CardTestScenario {
  const baloth = pinnedFrom(MARCHESA_BATCH1, 'Thunderfoot Baloth');
  const general = card({
    oracleId: 'lab-baloth-general',
    name: 'Lab General',
    typeLine: 'Legendary Creature — Elf Warrior',
    manaCost: '{2}{G}',
    cmc: 3,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '2',
    toughness: '2',
  });
  const relic = card({
    oracleId: 'lab-baloth-relic',
    name: 'Lab Relic',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
  });
  return pr01Scenario(gameId, {
    id: 'thunderfoot-baloth-viewer-lieutenant',
    title: 'Thunderfoot Baloth: lieutenant pumps your creatures',
    instructions: [
      'Your commander, Lab General, is on the battlefield. Cast Thunderfoot Baloth with your six Forests.',
      'Inspect your creatures once it resolves.',
    ],
    expectedOutcome:
      "Thunderfoot Baloth is 7/7. Lab General and Lab Ox get +2/+2 and trample. Lab Relic and your lands are not creatures and gain nothing, and P2's Lab Servo is unchanged.",
    oracleSha256: baloth.sha256,
    clauseIds: ['thunderfoot-baloth-lieutenant'],
    decks: {
      P1: [baloth.card, LAB_OX, relic, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST],
      P2: [LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    commanders: { P1: [general] },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Thunderfoot Baloth'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: [
            'Lab General',
            'Lab Ox',
            'Lab Relic',
            'Forest',
            'Forest',
            'Forest',
            'Forest',
            'Forest',
            'Forest',
          ],
        },
        { playerId: 'P2', cardNames: ['Lab Servo'] },
      ],
    },
  });
}

function tombFortressScenario(gameId: GameId): CardTestScenario {
  const fortress = pinnedFrom(MARCHESA_BATCH1, 'Tomb Fortress');
  return pr01Scenario(gameId, {
    id: 'tomb-fortress-viewer-mill-then-return',
    title: 'Tomb Fortress: mill four, then return a creature card',
    instructions: [
      'Activate Tomb Fortress with your five Swamps, tapping and exiling the Fortress.',
      'After the four cards are milled, choose Lab Ox, which was just milled, to return.',
    ],
    expectedOutcome:
      'Four cards are milled, then you choose among every creature card now in your graveyard (Lab Servo and the milled Lab Ox). Lab Ox enters under your control and Tomb Fortress is exiled.',
    oracleSha256: fortress.sha256,
    clauseIds: ['tomb-fortress-mill-then-return'],
    decks: {
      P1: [
        fortress.card,
        LAB_SERVO,
        SWAMP,
        SWAMP,
        SWAMP,
        SWAMP,
        SWAMP,
        FOREST,
        LAB_OX,
        FOREST,
        FOREST,
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Tomb Fortress', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'],
        },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Servo'] }],
    },
  });
}

function voiceOfManyScenario(gameId: GameId): CardTestScenario {
  const voice = pinnedFrom(MARCHESA_BATCH1, 'Voice of Many');
  const drawn = card({
    oracleId: 'lab-voice-drawn',
    name: 'Voice Drawn Card',
    typeLine: 'Creature — Scribe',
    power: '1',
    toughness: '1',
    manaCost: '{9}',
    cmc: 9,
  });
  return pr01Scenario(gameId, {
    id: 'voice-of-many-viewer-draw-per-opponent',
    title: 'Voice of Many: draw for each opponent with fewer creatures',
    instructions: [
      'Cast Voice of Many with your four Forests.',
      'Let its enters trigger resolve and count the cards you draw.',
    ],
    expectedOutcome:
      'You control two creatures (Lab Ox and Voice of Many). P2 (none) and P3 (one) control fewer, but P4 (two) does not, so you draw exactly two cards.',
    oracleSha256: voice.sha256,
    clauseIds: ['voice-of-many-enters-draw'],
    decks: {
      P1: [voice.card, LAB_OX, FOREST, FOREST, FOREST, FOREST, drawn, drawn, drawn],
      P2: PR01_FILLER,
      P3: [LAB_SERVO, FOREST, FOREST],
      P4: [LAB_OX, LAB_SERVO, FOREST, FOREST],
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Voice of Many'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Ox', 'Forest', 'Forest', 'Forest', 'Forest'] },
        { playerId: 'P3', cardNames: ['Lab Servo'] },
        { playerId: 'P4', cardNames: ['Lab Ox', 'Lab Servo'] },
      ],
    },
  });
}

function foeRazerRegentScenario(gameId: GameId): CardTestScenario {
  const regent = pinnedFrom(MARCHESA_BATCH1, 'Foe-Razer Regent');
  return pr01Scenario(gameId, {
    id: 'foe-razer-regent-viewer-fight-and-grow',
    title: 'Foe-Razer Regent: fight on entry, grow at the end step',
    instructions: [
      'Cast Foe-Razer Regent with your seven Forests.',
      "Target P2's Lab Ox with its enters trigger and choose to fight.",
      'Pass to the end step and watch the Regent get two +1/+1 counters.',
    ],
    expectedOutcome:
      'The Regent and Lab Ox deal damage to each other: Lab Ox dies and the 4/5 Regent survives with 4 damage. At the beginning of the end step it gets two +1/+1 counters and becomes 6/7.',
    oracleSha256: regent.sha256,
    clauseIds: ['foe-razer-regent-optional-fight', 'foe-razer-regent-fights-counters'],
    decks: {
      P1: [regent.card, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Foe-Razer Regent'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
        },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
      continueToEndStep: true,
    },
  });
}

function huntingWildsScenario(gameId: GameId): CardTestScenario {
  const wilds = pinnedFrom(MARCHESA_BATCH1, 'Hunting Wilds');
  const lands = Array.from({ length: 8 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'hunting-wilds-viewer-kicked',
    title: 'Hunting Wilds: kicked, two Forests become 3/3 haste creatures',
    instructions: [
      'Cast Hunting Wilds with kicker using your eight Forests.',
      'Choose both Forests from the library search.',
    ],
    expectedOutcome:
      'Both found Forests enter, untap, and become 3/3 green creatures with haste that are still lands; your library is shuffled.',
    oracleSha256: wilds.sha256,
    clauseIds: ['hunting-wilds-kicker', 'hunting-wilds-search', 'hunting-wilds-kicked-animate'],
    decks: {
      P1: [wilds.card, ...Array.from({ length: 10 }, () => FOREST)],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Hunting Wilds'] }],
      battlefield: [{ playerId: 'P1', cardNames: lands }],
    },
  });
}

function loranDestroyScenario(gameId: GameId): CardTestScenario {
  const loran = pinnedFrom(MARCHESA_BATCH1, 'Loran of the Third Path');
  return pr01Scenario(gameId, {
    id: 'loran-of-the-third-path-viewer-destroy-up-to-one',
    title: 'Loran of the Third Path: destroy up to one artifact or enchantment',
    instructions: [
      'Cast Loran of the Third Path with your three Plains.',
      'Choose Lab Hex for its enters trigger and let it resolve.',
    ],
    expectedOutcome:
      'Lab Hex is destroyed. Lab Servo, an artifact creature, was also offered but survives because only one target may be chosen; Lab Ox was never offered.',
    oracleSha256: loran.sha256,
    clauseIds: ['loran-of-the-third-path-destroy-up-to-one'],
    decks: {
      P1: [loran.card, PLAINS, PLAINS, PLAINS],
      P2: [LAB_HEX, LAB_SERVO, LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Loran of the Third Path'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Plains', 'Plains', 'Plains'] },
        { playerId: 'P2', cardNames: ['Lab Hex', 'Lab Servo', 'Lab Ox'] },
      ],
    },
  });
}

function loranDrawScenario(gameId: GameId): CardTestScenario {
  const loran = pinnedFrom(MARCHESA_BATCH1, 'Loran of the Third Path');
  const drawn = card({
    oracleId: 'lab-loran-drawn',
    name: 'Loran Drawn Card',
    typeLine: 'Creature — Scribe',
    manaCost: '{9}',
    cmc: 9,
    power: '1',
    toughness: '1',
  });
  return pr01Scenario(gameId, {
    id: 'loran-of-the-third-path-viewer-tap-draw',
    title: 'Loran of the Third Path: you and target opponent each draw',
    instructions: [
      'Activate Loran of the Third Path by tapping it.',
      'Target P3, then let the ability resolve.',
    ],
    expectedOutcome: 'Loran taps, and you and P3 each draw one card. P2 and P4 draw nothing.',
    oracleSha256: loran.sha256,
    clauseIds: ['loran-of-the-third-path-tap-draw'],
    decks: {
      P1: [loran.card, drawn],
      P2: PR01_FILLER,
      P3: [drawn, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Loran of the Third Path'] }],
    },
  });
}

function rishkarScenario(gameId: GameId): CardTestScenario {
  const rishkar = pinnedFrom(MARCHESA_BATCH1, 'Rishkar, Peema Renegade');
  return pr01Scenario(gameId, {
    id: 'rishkar-viewer-counters-and-mana',
    title: 'Rishkar, Peema Renegade: two counters, then countered creatures tap for G',
    instructions: [
      'Cast Rishkar, Peema Renegade with your three Forests.',
      "Choose Lab Ox and P2's Lab Servo for its two +1/+1 counters.",
    ],
    expectedOutcome:
      'Lab Ox becomes 5/5 and Lab Servo 2/2. Lab Ox now has "{T}: Add {G}" and shows as one ready mana source; P2\'s Servo grants P2 nothing because Rishkar only affects creatures you control.',
    oracleSha256: rishkar.sha256,
    clauseIds: ['rishkar-peema-renegade-enters-counters', 'rishkar-peema-renegade-mana-grant'],
    decks: {
      P1: [rishkar.card, LAB_OX, FOREST, FOREST, FOREST],
      P2: [LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Rishkar, Peema Renegade'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Ox', 'Forest', 'Forest', 'Forest'] },
        { playerId: 'P2', cardNames: ['Lab Servo'] },
      ],
    },
  });
}

function vastwoodSurgeScenario(gameId: GameId): CardTestScenario {
  const surge = pinnedFrom(MARCHESA_BATCH1, 'Vastwood Surge');
  const lands = Array.from({ length: 8 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'vastwood-surge-viewer-kicked',
    title: 'Vastwood Surge: kicked, two basics and counters on your creatures',
    instructions: [
      'Cast Vastwood Surge with kicker using your eight Forests.',
      'Choose the Plains and then the Island from the library search.',
    ],
    expectedOutcome:
      "The Plains and Island enter tapped, your library is shuffled, and Lab Ox gets two +1/+1 counters (6/6). P2's Lab Servo is not yours and stays 1/1.",
    oracleSha256: surge.sha256,
    clauseIds: ['vastwood-surge-kicker', 'vastwood-surge-search-and-counters'],
    decks: {
      P1: [surge.card, LAB_OX, ...Array.from({ length: 8 }, () => FOREST), PLAINS, ISLAND],
      P2: [LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Vastwood Surge'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Ox', ...lands] },
        { playerId: 'P2', cardNames: ['Lab Servo'] },
      ],
    },
  });
}

function frontierSiegeKhansScenario(gameId: GameId): CardTestScenario {
  const siege = pinnedFrom(MARCHESA_BATCH1, 'Frontier Siege');
  const wurm = card({
    oracleId: 'lab-siege-wurm',
    name: 'Lab Wurm',
    typeLine: 'Creature — Wurm',
    manaCost: '{G}{G}',
    cmc: 2,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '3',
    toughness: '3',
  });
  return pr01Scenario(gameId, {
    id: 'frontier-siege-viewer-khans-mana',
    title: 'Frontier Siege: Khans adds {G}{G} at your next main phase',
    instructions: [
      'Cast Frontier Siege with your four Forests and choose Khans.',
      'Pass through combat. At the beginning of your postcombat main phase, use the {G}{G} it adds to cast Lab Wurm.',
    ],
    expectedOutcome:
      'Your lands are all tapped, but the Khans trigger adds {G}{G} at the beginning of your postcombat main phase, which pays for Lab Wurm.',
    oracleSha256: siege.sha256,
    clauseIds: ['frontier-siege-choose-mode', 'frontier-siege-khans'],
    decks: {
      P1: [siege.card, wurm, FOREST, FOREST, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Frontier Siege', 'Lab Wurm'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest', 'Forest', 'Forest'] }],
      continueThroughCombat: true,
      continueToPostcombatMain: true,
    },
  });
}

function frontierSiegeDragonsScenario(gameId: GameId): CardTestScenario {
  const siege = pinnedFrom(MARCHESA_BATCH1, 'Frontier Siege');
  const drake = card({
    oracleId: 'lab-siege-drake',
    name: 'Lab Drake',
    typeLine: 'Creature — Drake',
    oracleText: 'Flying',
    manaCost: '{2}',
    cmc: 2,
    power: '3',
    toughness: '3',
  });
  return pr01Scenario(gameId, {
    id: 'frontier-siege-viewer-dragons-fight',
    title: 'Frontier Siege: Dragons lets an entering flier fight',
    instructions: [
      'Cast Frontier Siege with four of your Forests and choose Dragons.',
      "Cast Lab Drake, then choose to have it fight P2's Lab Servo.",
    ],
    expectedOutcome:
      'Lab Drake and Lab Servo deal damage to each other: Lab Servo dies and the 3/3 Drake survives with 1 damage.',
    oracleSha256: siege.sha256,
    clauseIds: ['frontier-siege-choose-mode', 'frontier-siege-dragons'],
    decks: {
      P1: [siege.card, drake, FOREST, FOREST, FOREST, FOREST, FOREST, FOREST],
      P2: [LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Frontier Siege', 'Lab Drake'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
        },
        { playerId: 'P2', cardNames: ['Lab Servo'] },
      ],
    },
  });
}

function kairiScenario(gameId: GameId): CardTestScenario {
  const kairi = pinnedFrom(MARCHESA_BATCH1, 'Kairi, the Swirling Sky');
  const idol = card({
    oracleId: 'lab-kairi-idol',
    name: 'Lab Idol',
    typeLine: 'Artifact',
    manaCost: '{2}',
    cmc: 2,
  });
  return pr01Scenario(gameId, {
    id: 'kairi-viewer-bounce-total-six',
    title: 'Kairi, the Swirling Sky: dies, bounce up to total mana value 6',
    instructions: [
      'Cast Lab Doom on your own Kairi, the Swirling Sky.',
      'When Kairi dies, choose the return mode, then choose Lab Ox (mana value 4) and Lab Idol (2).',
    ],
    expectedOutcome:
      "After Lab Ox, Lab Hex (mana value 3) is no longer offered because it would exceed 6. Lab Ox and Lab Idol return to P2's hand; Lab Hex stays.",
    oracleSha256: kairi.sha256,
    clauseIds: ['kairi-the-swirling-sky-dies-modes', 'kairi-the-swirling-sky-bounce'],
    decks: {
      P1: [kairi.card, LAB_DOOM, SWAMP, SWAMP],
      P2: [LAB_OX, LAB_HEX, idol, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Kairi, the Swirling Sky', 'Swamp', 'Swamp'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Hex', 'Lab Idol'] },
      ],
    },
  });
}

function kairiMillScenario(gameId: GameId): CardTestScenario {
  const kairi = pinnedFrom(MARCHESA_BATCH1, 'Kairi, the Swirling Sky');
  return pr01Scenario(gameId, {
    id: 'kairi-viewer-mill-and-return',
    title: 'Kairi, the Swirling Sky: dies, mill six and return a spell',
    instructions: [
      'Cast Lab Doom on your own Kairi, the Swirling Sky.',
      'When Kairi dies, choose the mill mode. Return Lab Shock, then choose to stop returning.',
    ],
    expectedOutcome:
      'Your six library cards are milled. Instant and sorcery cards in your graveyard (Lab Shock and both copies of Lab Doom) are offered; Lab Shock returns to your hand and you stop after one.',
    oracleSha256: kairi.sha256,
    clauseIds: ['kairi-the-swirling-sky-dies-modes', 'kairi-the-swirling-sky-mill'],
    decks: {
      P1: [kairi.card, LAB_DOOM, SWAMP, SWAMP, LAB_SHOCK, LAB_DOOM, FOREST, FOREST, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Kairi, the Swirling Sky', 'Swamp', 'Swamp'] }],
    },
  });
}

function willOfTheMarduScenario(gameId: GameId): CardTestScenario {
  const will = pinnedFrom(MARCHESA_BATCH1, 'Will of the Mardu');
  const general = card({
    oracleId: 'lab-mardu-general',
    name: 'Lab Warlord',
    typeLine: 'Legendary Creature — Orc Warrior',
    manaCost: '{2}{W}',
    cmc: 3,
    colors: ['W'],
    colorIdentity: ['W'],
    power: '2',
    toughness: '2',
  });
  const brute = card({
    oracleId: 'lab-mardu-brute',
    name: 'Lab Brute',
    typeLine: 'Creature — Ogre',
    manaCost: '{3}',
    cmc: 3,
    power: '3',
    toughness: '3',
  });
  return pr01Scenario(gameId, {
    id: 'will-of-the-mardu-viewer-choose-both',
    title: 'Will of the Mardu: choose both while you control a commander',
    instructions: [
      'Your commander, Lab Warlord, is on the battlefield, so Will of the Mardu may choose both modes.',
      'Cast it choosing both, targeting P2 for the Warriors and Lab Brute for the damage.',
    ],
    expectedOutcome:
      'You create two 1/1 red Warriors (P2 controls two creatures). Then the damage counts your three creatures, so the 3/3 Lab Brute dies.',
    oracleSha256: will.sha256,
    clauseIds: [
      'will-of-the-mardu-choose',
      'will-of-the-mardu-warriors',
      'will-of-the-mardu-damage',
    ],
    decks: {
      P1: [will.card, PLAINS, PLAINS, PLAINS],
      P2: [brute, LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    commanders: { P1: [general] },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Will of the Mardu'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Warlord', 'Plains', 'Plains', 'Plains'] },
        { playerId: 'P2', cardNames: ['Lab Brute', 'Lab Servo'] },
      ],
    },
  });
}

function aetherChannelerScenario(gameId: GameId): CardTestScenario {
  const channeler = pinnedFrom(MARCHESA_BATCH1, 'Aether Channeler');
  return pr01Scenario(gameId, {
    id: 'aether-channeler-viewer-bounce-another',
    title: 'Aether Channeler: return another target nonland permanent',
    instructions: [
      'Cast Aether Channeler with your three Islands.',
      "Choose the return mode, then target P2's Lab Ox.",
    ],
    expectedOutcome:
      "Lab Ox returns to P2's hand. The Channeler itself and the lands were never offered as targets.",
    oracleSha256: channeler.sha256,
    clauseIds: ['aether-channeler-enters-modes', 'aether-channeler-bounce'],
    decks: {
      P1: [channeler.card, ISLAND, ISLAND, ISLAND],
      P2: [LAB_OX, LAB_HEX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Aether Channeler'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Island', 'Island', 'Island'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Hex'] },
      ],
    },
  });
}

function aetherChannelerBirdScenario(gameId: GameId): CardTestScenario {
  const channeler = pinnedFrom(MARCHESA_BATCH1, 'Aether Channeler');
  return pr01Scenario(gameId, {
    id: 'aether-channeler-viewer-bird',
    title: 'Aether Channeler: create a 1/1 white Bird with flying',
    instructions: ['Cast Aether Channeler with your three Islands.', 'Choose the Bird mode.'],
    expectedOutcome:
      'A 1/1 white Bird creature token with flying enters under your control. Nothing is returned and no card is drawn.',
    oracleSha256: channeler.sha256,
    clauseIds: ['aether-channeler-enters-modes', 'aether-channeler-bird'],
    decks: {
      P1: [channeler.card, ISLAND, ISLAND, ISLAND],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Aether Channeler'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Island', 'Island', 'Island'] },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
    },
  });
}

function aetherChannelerDrawScenario(gameId: GameId): CardTestScenario {
  const channeler = pinnedFrom(MARCHESA_BATCH1, 'Aether Channeler');
  const drawn = card({
    oracleId: 'lab-channeler-drawn',
    name: 'Channeler Drawn Card',
    typeLine: 'Creature — Scribe',
    manaCost: '{9}',
    cmc: 9,
    power: '1',
    toughness: '1',
  });
  return pr01Scenario(gameId, {
    id: 'aether-channeler-viewer-draw',
    title: 'Aether Channeler: draw a card',
    instructions: ['Cast Aether Channeler with your three Islands.', 'Choose the draw mode.'],
    expectedOutcome:
      'You draw Channeler Drawn Card, the only card left in your library. No token is created and nothing is returned.',
    oracleSha256: channeler.sha256,
    clauseIds: ['aether-channeler-enters-modes', 'aether-channeler-draw'],
    decks: {
      P1: [channeler.card, ISLAND, ISLAND, ISLAND, drawn],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Aether Channeler'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Island', 'Island', 'Island'] },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
    },
  });
}

function returnToNatureDestroyScenario(gameId: GameId): CardTestScenario {
  const nature = pinnedFrom(MARCHESA_BATCH1, 'Return to Nature');
  return pr01Scenario(gameId, {
    id: 'return-to-nature-viewer-destroy-enchantment',
    title: 'Return to Nature: destroy target enchantment',
    instructions: [
      'Cast Return to Nature with your two Forests, choosing the enchantment mode.',
      "Target P2's Lab Hex.",
    ],
    expectedOutcome:
      'Lab Hex is destroyed. Only the enchantment and graveyard modes were offered, because no artifact was on the battlefield.',
    oracleSha256: nature.sha256,
    clauseIds: ['return-to-nature-choose-one', 'return-to-nature-destroy-enchantment'],
    decks: {
      P1: [nature.card, FOREST, FOREST],
      P2: [LAB_HEX, LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Return to Nature'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Forest', 'Forest'] },
        { playerId: 'P2', cardNames: ['Lab Hex'] },
      ],
      graveyard: [{ playerId: 'P2', cardNames: ['Lab Ox'] }],
    },
  });
}

function returnToNatureExileScenario(gameId: GameId): CardTestScenario {
  const nature = pinnedFrom(MARCHESA_BATCH1, 'Return to Nature');
  return pr01Scenario(gameId, {
    id: 'return-to-nature-viewer-exile-graveyard-card',
    title: 'Return to Nature: exile target card from a graveyard',
    instructions: [
      'Cast Return to Nature with your two Forests, choosing the graveyard mode.',
      'Target Lab Servo in your graveyard.',
    ],
    expectedOutcome: 'Lab Servo moves from your graveyard to exile.',
    oracleSha256: nature.sha256,
    clauseIds: ['return-to-nature-choose-one', 'return-to-nature-exile-graveyard-card'],
    decks: {
      P1: [nature.card, LAB_SERVO, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Return to Nature'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Forest', 'Forest'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Servo'] }],
    },
  });
}

function mysticSanctuaryScenario(gameId: GameId): CardTestScenario {
  const sanctuary = pinnedFrom(COVERAGE_PR01, 'Mystic Sanctuary');
  return pr01Scenario(gameId, {
    id: 'mystic-sanctuary-viewer-untapped-return',
    title: 'Mystic Sanctuary: enters untapped and returns an instant',
    instructions: [
      'Play Mystic Sanctuary as your land drop. You control three other Islands, so it enters untapped.',
      'Choose to put Lab Shock from your graveyard on top of your library.',
    ],
    expectedOutcome:
      'Mystic Sanctuary enters untapped and Lab Shock moves from your graveyard to the top of your library.',
    oracleSha256: sanctuary.sha256,
    clauseIds: ['mystic-sanctuary-enters-tapped-unless', 'mystic-sanctuary-untapped-trigger'],
    decks: {
      P1: [sanctuary.card, ISLAND, ISLAND, ISLAND, LAB_SHOCK],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Mystic Sanctuary'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Island', 'Island'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Shock'] }],
    },
  });
}

function brokersHideoutScenario(gameId: GameId): CardTestScenario {
  const hideout = pinnedFrom(COVERAGE_PR01, 'Brokers Hideout');
  return pr01Scenario(gameId, {
    id: 'brokers-hideout-viewer-sacrifice-and-search',
    title: 'Brokers Hideout: sacrifice it, then search for a basic',
    instructions: [
      'Play Brokers Hideout as your land drop.',
      'Its enters trigger sacrifices it; then choose the Plains from the search.',
    ],
    expectedOutcome:
      'Brokers Hideout goes to your graveyard. A separate trigger then puts the Plains onto the battlefield tapped, shuffles your library, and you gain 1 life (41). The Swamp is never offered.',
    oracleSha256: hideout.sha256,
    clauseIds: ['brokers-hideout-sacrifice-search'],
    decks: {
      P1: [hideout.card, PLAINS, ISLAND, SWAMP],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Brokers Hideout'] }],
      battlefield: [],
    },
  });
}

function sweetGumRecluseScenario(gameId: GameId): CardTestScenario {
  const recluse = pinnedFrom(COVERAGE_PR01, 'Sweet-Gum Recluse');
  const sprout = card({
    oracleId: 'lab-recluse-sprout',
    name: 'Lab Sprout',
    typeLine: 'Creature — Plant',
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '1',
    toughness: '1',
  });
  const forests = Array.from({ length: 7 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'sweet-gum-recluse-viewer-new-creatures',
    title: 'Sweet-Gum Recluse: counters on creatures that entered this turn',
    instructions: [
      'Cast Lab Sprout, then cast Sweet-Gum Recluse (its cascade finds only lands).',
      'Choose Lab Sprout and Sweet-Gum Recluse for its counters, then stop.',
    ],
    expectedOutcome:
      'Lab Sprout becomes 4/4 and Sweet-Gum Recluse 3/6. Lab Ox, which was already on the battlefield, is never offered.',
    oracleSha256: recluse.sha256,
    clauseIds: ['sweet-gum-recluse-enters-counters'],
    decks: {
      P1: [
        recluse.card,
        sprout,
        LAB_OX,
        ...Array.from({ length: 7 }, () => FOREST),
        FOREST,
        FOREST,
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Sweet-Gum Recluse', 'Lab Sprout'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Lab Ox', ...forests] }],
    },
  });
}

function sweetGumRecluseFlashCascadeScenario(gameId: GameId): CardTestScenario {
  const recluse = pinnedFrom(COVERAGE_PR01, 'Sweet-Gum Recluse');
  const seedling = card({
    oracleId: 'lab-recluse-seedling',
    name: 'Lab Seedling',
    typeLine: 'Creature — Plant',
    manaCost: '{1}{G}',
    cmc: 2,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '1',
    toughness: '1',
  });
  const bystander = card({
    oracleId: 'lab-recluse-bystander',
    name: 'Lab Bystander',
    typeLine: 'Creature — Elf',
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '1',
    toughness: '1',
  });
  const forests = Array.from({ length: 6 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'sweet-gum-recluse-viewer-flash-cascade',
    title: 'Sweet-Gum Recluse: flash in response, cascade into a cheaper spell',
    instructions: [
      "P2's Lab Pending Spell is on the stack. Lab Bystander has no flash, so it cannot be cast now.",
      'Cast Sweet-Gum Recluse in response (flash); its cascade exiles until Lab Seedling.',
      'Cast Lab Seedling without paying its mana cost, then choose Lab Seedling and Sweet-Gum Recluse for the counters.',
    ],
    expectedOutcome:
      "Lab Seedling resolves first and becomes 4/4; Sweet-Gum Recluse becomes 3/6. Lab Bystander stays in your hand, and P2's spell resolves last.",
    oracleSha256: recluse.sha256,
    clauseIds: ['sweet-gum-recluse-flash', 'sweet-gum-recluse-cascade'],
    decks: {
      P1: [recluse.card, bystander, seedling, ...Array.from({ length: 8 }, () => FOREST)],
      P2: [ARCANE_PENDING_SPELL, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Sweet-Gum Recluse', 'Lab Bystander'] }],
      battlefield: [{ playerId: 'P1', cardNames: forests }],
      stack: [{ playerId: 'P2', cardNames: ['Lab Pending Spell'] }],
    },
  });
}

/** P2's seat in the reach scenario: attack P1 with every creature, otherwise pass. */
const attackP1WithEverything: DecisionProvider = {
  decide(request) {
    const attack = request.legalActions.find((action) =>
      action.description.startsWith('Declare attackers'),
    );
    if (attack !== undefined) {
      return {
        requestId: request.requestId,
        actionId: attack.id,
        targets: (attack.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.includes('P1') ? 'P1' : (slot.options[0] as string),
        })),
      };
    }
    const pass = request.legalActions.find((action) => action.type === 'pass');
    return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
  },
};

function sweetGumRecluseReachScenario(gameId: GameId): CardTestScenario {
  const recluse = pinnedFrom(COVERAGE_PR01, 'Sweet-Gum Recluse');
  const drake = card({
    oracleId: 'lab-recluse-drake',
    name: 'Lab Drake',
    typeLine: 'Creature — Drake',
    manaCost: '{1}{U}',
    cmc: 2,
    colors: ['U'],
    colorIdentity: ['U'],
    power: '2',
    toughness: '2',
    oracleText: 'Flying',
  });
  return pr01Scenario(gameId, {
    id: 'sweet-gum-recluse-viewer-reach-block',
    title: 'Sweet-Gum Recluse: reach blocks a flier',
    instructions: [
      "It is P2's turn. P2 attacks you with Lab Drake, which has flying.",
      'Declare Sweet-Gum Recluse as a blocker for Lab Drake. Lab Ox has no reach and is not offered.',
    ],
    expectedOutcome: 'Sweet-Gum Recluse blocks Lab Drake and takes 2 damage; you stay at 40 life.',
    oracleSha256: recluse.sha256,
    clauseIds: ['sweet-gum-recluse-reach'],
    decks: {
      P1: [recluse.card, LAB_OX, FOREST, FOREST],
      P2: [drake, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      currentTurnPlayer: 'P2',
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Sweet-Gum Recluse', 'Lab Ox'] },
        { playerId: 'P2', cardNames: ['Lab Drake'] },
      ],
      continueThroughCombat: true,
    },
    decisionProviderOverrides: { P2: attackP1WithEverything },
  });
}

function koglaFightScenario(gameId: GameId): CardTestScenario {
  const kogla = pinnedFrom(COVERAGE_PR01, 'Kogla, the Titan Ape');
  const forests = Array.from({ length: 6 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'kogla-viewer-enters-fight',
    title: 'Kogla, the Titan Ape: fight up to one creature on entry',
    instructions: [
      'Cast Kogla, the Titan Ape with your six Forests.',
      "Choose P2's Lab Ox for its enters fight.",
    ],
    expectedOutcome:
      'Kogla (7/6) and Lab Ox (4/4) deal damage to each other: Lab Ox dies and Kogla survives with 4 damage.',
    oracleSha256: kogla.sha256,
    clauseIds: ['kogla-the-titan-ape-enters-fight'],
    decks: {
      P1: [kogla.card, ...Array.from({ length: 6 }, () => FOREST)],
      P2: [LAB_OX, LAB_SERVO, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Kogla, the Titan Ape'] }],
      battlefield: [
        { playerId: 'P1', cardNames: forests },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Servo'] },
      ],
    },
  });
}

function koglaAttackScenario(gameId: GameId): CardTestScenario {
  const kogla = pinnedFrom(COVERAGE_PR01, 'Kogla, the Titan Ape');
  const squire = card({
    oracleId: 'lab-kogla-squire',
    name: 'Lab Squire',
    typeLine: 'Creature — Human Soldier',
    manaCost: '{W}',
    cmc: 1,
    colors: ['W'],
    colorIdentity: ['W'],
    power: '1',
    toughness: '1',
  });
  const idol = card({
    oracleId: 'lab-kogla-idol',
    name: 'Lab Idol',
    typeLine: 'Artifact',
    manaCost: '{2}',
    cmc: 2,
  });
  return pr01Scenario(gameId, {
    id: 'kogla-viewer-bounce-and-attack',
    title: 'Kogla, the Titan Ape: bounce a Human, then attack',
    instructions: [
      'Activate Kogla for {1}{G}, returning your Lab Squire to your hand.',
      'Attack P2 with Kogla; its attack trigger destroys an artifact or enchantment P2 controls.',
    ],
    expectedOutcome:
      "Lab Squire returns to your hand and Kogla gains indestructible. When Kogla attacks P2, Lab Hex (P2's only artifact or enchantment) is destroyed; P3's Lab Idol is untouched.",
    oracleSha256: kogla.sha256,
    clauseIds: ['kogla-the-titan-ape-attack-destroy', 'kogla-the-titan-ape-human-bounce'],
    decks: {
      P1: [kogla.card, squire, FOREST, FOREST],
      P2: [LAB_HEX, FOREST, FOREST],
      P3: [idol, FOREST, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Kogla, the Titan Ape', 'Lab Squire', 'Forest', 'Forest'] },
        { playerId: 'P2', cardNames: ['Lab Hex'] },
        { playerId: 'P3', cardNames: ['Lab Idol'] },
      ],
      continueThroughCombat: true,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Coverage PR02 (docs/plans/card-coverage-chunks.md): activation and casting costs. Scenarios
// reuse the PR01 builder (`pr01Scenario`), which is generic over the prepared board.
// ---------------------------------------------------------------------------------------------

function retrofitterFoundryScenario(gameId: GameId): CardTestScenario {
  const foundry = pinnedFrom(MARCHESA_BATCH1, 'Retrofitter Foundry');
  const forests = Array.from({ length: 9 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'retrofitter-foundry-viewer-servo-thopter-construct',
    title: 'Retrofitter Foundry: Servo, Thopter, then Construct',
    instructions: [
      'Activate {2}, {T} to create a Servo, then {3} to untap the Foundry.',
      'Activate {1}, {T}, sacrificing the Servo, to create a Thopter, then {3} to untap again.',
      'Activate {T}, sacrificing the Thopter, to create a Construct.',
    ],
    expectedOutcome:
      'All nine Forests are spent; the Servo and Thopter were sacrificed as costs and a 4/4 Construct token remains.',
    oracleSha256: foundry.sha256,
    clauseIds: [
      'retrofitter-foundry-untap',
      'retrofitter-foundry-servo',
      'retrofitter-foundry-thopter',
      'retrofitter-foundry-construct',
    ],
    decks: {
      P1: [foundry.card, ...Array.from({ length: 9 }, () => FOREST)],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Retrofitter Foundry', ...forests] }],
    },
  });
}

const LAB_GREEN_BEAR = card({
  oracleId: 'lab-green-bear',
  name: 'Lab Green Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{G}',
  cmc: 1,
  colors: ['G'],
  colorIdentity: ['G'],
  power: '2',
  toughness: '2',
});
const LAB_GENERIC_BEAR = card({
  oracleId: 'lab-generic-bear',
  name: 'Lab Generic Bear',
  typeLine: 'Artifact Creature — Bear',
  manaCost: '{1}',
  cmc: 1,
  power: '1',
  toughness: '1',
});

function aetherHubEnergyScenario(gameId: GameId): CardTestScenario {
  const hub = pinnedFrom(MARCHESA_BATCH1, 'Aether Hub');
  return pr01Scenario(gameId, {
    id: 'aether-hub-viewer-energy-any-color',
    title: 'Aether Hub: enter for energy, then pay it for green',
    instructions: [
      'Play Aether Hub; its enters trigger gives you one energy.',
      'Cast Lab Green Bear, paying {G} with Aether Hub and one energy.',
    ],
    expectedOutcome:
      'Aether Hub enters untapped and gives one energy, then taps and spends it for {G}: Lab Green Bear resolves and you end with zero energy.',
    oracleSha256: hub.sha256,
    clauseIds: ['aether-hub-enters-energy', 'aether-hub-energy-any-color'],
    decks: { P1: [hub.card, LAB_GREEN_BEAR], P2: PR01_FILLER, P3: PR01_FILLER, P4: PR01_FILLER },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Aether Hub', 'Lab Green Bear'] }],
      battlefield: [],
    },
  });
}

function aetherHubColorlessScenario(gameId: GameId): CardTestScenario {
  const hub = pinnedFrom(MARCHESA_BATCH1, 'Aether Hub');
  return pr01Scenario(gameId, {
    id: 'aether-hub-viewer-colorless',
    title: 'Aether Hub: colorless mana with no energy',
    instructions: [
      'With no energy, cast Lab Generic Bear by tapping Aether Hub for {C}.',
      'Lab Green Bear stays uncastable: the Hub cannot make {G} without energy.',
    ],
    expectedOutcome:
      'Aether Hub taps for {C} and Lab Generic Bear resolves; you still have zero energy and Lab Green Bear is still in hand.',
    oracleSha256: hub.sha256,
    clauseIds: ['aether-hub-colorless'],
    decks: {
      P1: [hub.card, LAB_GREEN_BEAR, LAB_GENERIC_BEAR],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Green Bear', 'Lab Generic Bear'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Aether Hub'] }],
    },
  });
}

const LAB_RED_BEAR = card({
  oracleId: 'lab-red-bear',
  name: 'Lab Red Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{R}',
  cmc: 1,
  colors: ['R'],
  colorIdentity: ['R'],
  power: '2',
  toughness: '2',
});

function solarTransformerEnergyScenario(gameId: GameId): CardTestScenario {
  const transformer = pinnedFrom(MARCHESA_BATCH1, 'Solar Transformer');
  return pr01Scenario(gameId, {
    id: 'solar-transformer-viewer-cast-and-energy-mana',
    title: 'Solar Transformer: enter tapped for energy, then pay it for red',
    instructions: [
      'Cast the Solar Transformer in your hand with your two Forests; it enters tapped and gives three energy.',
      'Cast Lab Red Bear, paying {R} with the untapped Solar Transformer and one energy.',
    ],
    expectedOutcome:
      'The new Solar Transformer is tapped and gave three energy; the other one taps and spends one for {R}, so Lab Red Bear resolves and you end with two energy.',
    oracleSha256: transformer.sha256,
    clauseIds: [
      'solar-transformer-enters-tapped',
      'solar-transformer-enters-energy',
      'solar-transformer-energy-any-color',
    ],
    decks: {
      P1: [transformer.card, transformer.card, FOREST, FOREST, LAB_RED_BEAR],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Solar Transformer', 'Lab Red Bear'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Solar Transformer', 'Forest', 'Forest'] }],
    },
  });
}

function solarTransformerColorlessScenario(gameId: GameId): CardTestScenario {
  const transformer = pinnedFrom(MARCHESA_BATCH1, 'Solar Transformer');
  return pr01Scenario(gameId, {
    id: 'solar-transformer-viewer-colorless',
    title: 'Solar Transformer: colorless mana with no energy',
    instructions: [
      'With no energy, cast Lab Generic Bear by tapping Solar Transformer for {C}.',
      'Lab Red Bear stays uncastable: the Transformer cannot make {R} without energy.',
    ],
    expectedOutcome:
      'Solar Transformer taps for {C} and Lab Generic Bear resolves; you still have zero energy and Lab Red Bear is still in hand.',
    oracleSha256: transformer.sha256,
    clauseIds: ['solar-transformer-colorless'],
    decks: {
      P1: [transformer.card, LAB_RED_BEAR, LAB_GENERIC_BEAR],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Red Bear', 'Lab Generic Bear'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Solar Transformer'] }],
    },
  });
}

const LAB_GIANT = card({
  oracleId: 'lab-giant',
  name: 'Lab Giant',
  typeLine: 'Creature — Giant',
  manaCost: '{4}',
  cmc: 4,
  power: '4',
  toughness: '4',
});

function battlewagonScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    instructions: string[];
    expectedOutcome: string;
    clauseIds: string[];
    energy: number;
    extras: OracleCard[];
    opponentBoard?: OracleCard[];
  },
): CardTestScenario {
  const wagon = pinnedFrom(MARCHESA_BATCH1, 'Bespoke Battlewagon');
  const opponent = spec.opponentBoard ?? [];
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: wagon.sha256,
    clauseIds: spec.clauseIds,
    decks: {
      P1: [wagon.card, ...spec.extras, FOREST],
      P2: [...opponent, ...PR01_FILLER],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Bespoke Battlewagon', ...spec.extras.map((extra) => extra.name)],
        },
        { playerId: 'P2', cardNames: opponent.map((extra) => extra.name) },
      ],
      energy: [{ playerId: 'P1', amount: spec.energy }],
    },
  });
}

const battlewagonGainAndCrewScenario = (gameId: GameId): CardTestScenario =>
  battlewagonScenario(gameId, {
    id: 'bespoke-battlewagon-viewer-energy-and-crew',
    title: 'Bespoke Battlewagon: tap for energy, then crew 4',
    instructions: ['Activate {T}: You get {E}{E}.', 'Then crew it with Lab Giant (power 4).'],
    expectedOutcome:
      'You have two energy, Battlewagon is tapped and is a 5/6 artifact creature, and Lab Giant is tapped for crew.',
    clauseIds: ['bespoke-battlewagon-gain-energy', 'bespoke-battlewagon-crew'],
    energy: 0,
    extras: [LAB_GIANT],
  });

const battlewagonAnimateAndDrawScenario = (gameId: GameId): CardTestScenario =>
  battlewagonScenario(gameId, {
    id: 'bespoke-battlewagon-viewer-animate-and-draw',
    title: 'Bespoke Battlewagon: pay four energy to animate, then draw',
    instructions: [
      'Starting with seven energy, pay {E}{E}{E}{E}: Battlewagon becomes an artifact creature.',
      'Then activate {T}, Pay {E}{E}{E}: Draw a card.',
    ],
    expectedOutcome:
      'Battlewagon is a 5/6 artifact creature without being crewed, it is tapped, you drew the Forest, and you have no energy left.',
    clauseIds: ['bespoke-battlewagon-animate', 'bespoke-battlewagon-draw'],
    energy: 7,
    extras: [],
  });

const battlewagonTapTargetScenario = (gameId: GameId): CardTestScenario =>
  battlewagonScenario(gameId, {
    id: 'bespoke-battlewagon-viewer-tap-target',
    title: "Bespoke Battlewagon: pay two energy to tap P2's creature",
    instructions: ["Starting with two energy, activate {T}, Pay {E}{E} targeting P2's Lab Ox."],
    expectedOutcome: 'Lab Ox is tapped, Battlewagon is tapped, and you have no energy left.',
    clauseIds: ['bespoke-battlewagon-tap-target'],
    energy: 2,
    extras: [],
    opponentBoard: [LAB_OX],
  });

const LAB_ATLAS_PAGE = card({
  oracleId: 'lab-atlas-page',
  name: 'Atlas Drawn Page',
  typeLine: 'Creature — Secret',
});

function endlessAtlasScenario(gameId: GameId): CardTestScenario {
  const atlas = pinnedFrom(MARCHESA_BATCH1, 'Endless Atlas');
  return pr01Scenario(gameId, {
    id: 'endless-atlas-viewer-same-name-draw',
    title: 'Endless Atlas: three Forests unlock the draw',
    instructions: ['With three Forests, activate Endless Atlas for {2} and draw a card.'],
    expectedOutcome:
      'Two Forests and Endless Atlas tap; the three Forests still satisfy the same-name condition and you draw Atlas Drawn Page.',
    oracleSha256: atlas.sha256,
    clauseIds: ['endless-atlas-same-name-draw'],
    decks: {
      P1: [atlas.card, FOREST, FOREST, FOREST, LAB_ATLAS_PAGE],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Endless Atlas', 'Forest', 'Forest', 'Forest'] }],
    },
  });
}

function endlessAtlasBlockedScenario(gameId: GameId): CardTestScenario {
  const atlas = pinnedFrom(MARCHESA_BATCH1, 'Endless Atlas');
  return pr01Scenario(gameId, {
    id: 'endless-atlas-viewer-mixed-names-blocked',
    title: 'Endless Atlas: two Forests and an Island do not unlock it',
    instructions: ['With two Forests and an Island, Endless Atlas offers no activation; pass.'],
    expectedOutcome: 'Endless Atlas is never actionable and you draw nothing.',
    oracleSha256: atlas.sha256,
    clauseIds: ['endless-atlas-same-name-draw'],
    decks: {
      P1: [atlas.card, FOREST, FOREST, ISLAND, LAB_ATLAS_PAGE],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Endless Atlas', 'Forest', 'Forest', 'Island'] }],
    },
  });
}

const LAB_BLACK_OGRE = card({
  oracleId: 'lab-black-ogre',
  name: 'Lab Black Ogre',
  typeLine: 'Creature — Ogre',
  manaCost: '{B}{B}{B}',
  cmc: 3,
  colors: ['B'],
  colorIdentity: ['B'],
  power: '3',
  toughness: '3',
});
const LAB_BLACK_BEAR = card({
  oracleId: 'lab-black-bear',
  name: 'Lab Black Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{B}',
  cmc: 1,
  colors: ['B'],
  colorIdentity: ['B'],
  power: '2',
  toughness: '2',
});

function sceptreScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    lands: OracleCard[];
    instructions: string[];
    expectedOutcome: string;
  },
): CardTestScenario {
  const sceptre = pinnedFrom(MARCHESA_BATCH1, 'Sceptre of Eternal Glory');
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: sceptre.sha256,
    clauseIds: [
      'sceptre-of-eternal-glory-any-color',
      'sceptre-of-eternal-glory-three-of-one-color',
    ],
    decks: {
      P1: [sceptre.card, ...spec.lands, LAB_BLACK_OGRE, LAB_BLACK_BEAR],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Black Ogre', 'Lab Black Bear'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Sceptre of Eternal Glory'] },
        { playerId: 'P1', cardNames: spec.lands.map((land) => land.name), tapped: true },
      ],
    },
  });
}

const sceptreThreeScenario = (gameId: GameId): CardTestScenario =>
  sceptreScenario(gameId, {
    id: 'sceptre-of-eternal-glory-viewer-three-black',
    title: 'Sceptre of Eternal Glory: three Forests unlock {B}{B}{B}',
    lands: [FOREST, FOREST, FOREST],
    instructions: [
      'Your three Forests are tapped but still share a name.',
      'Cast Lab Black Ogre ({B}{B}{B}) with Sceptre of Eternal Glory alone.',
    ],
    expectedOutcome:
      'Sceptre taps for three black mana and Lab Black Ogre resolves; Lab Black Bear stays in hand.',
  });

const sceptreOneScenario = (gameId: GameId): CardTestScenario =>
  sceptreScenario(gameId, {
    id: 'sceptre-of-eternal-glory-viewer-one-mana',
    title: 'Sceptre of Eternal Glory: mixed lands give one mana',
    lands: [FOREST, FOREST, ISLAND],
    instructions: [
      'With two Forests and an Island, only the one-mana ability is available.',
      'Lab Black Ogre is not castable; cast Lab Black Bear ({B}).',
    ],
    expectedOutcome:
      'Sceptre taps for one black mana and Lab Black Bear resolves; Lab Black Ogre stays in hand.',
  });

const LAB_REVEALED_LAND = card({
  oracleId: 'lab-wayfarer-land',
  name: 'Wayfarer Revealed Land',
  typeLine: 'Land',
  manaCost: null,
  cmc: 0,
});

function weatheredWayfarerScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    opponentLands: number;
    instructions: string[];
    expectedOutcome: string;
  },
): CardTestScenario {
  const wayfarer = pinnedFrom(MARCHESA_BATCH1, 'Weathered Wayfarer');
  const forests = Array.from({ length: spec.opponentLands }, () => FOREST);
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: wayfarer.sha256,
    clauseIds: ['weathered-wayfarer-conditional-search'],
    decks: {
      P1: [wayfarer.card, PLAINS, LAB_REVEALED_LAND, ISLAND],
      P2: [...forests, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Weathered Wayfarer', 'Plains'] },
        { playerId: 'P2', cardNames: forests.map((land) => land.name) },
      ],
    },
  });
}

const weatheredWayfarerSearchScenario = (gameId: GameId): CardTestScenario =>
  weatheredWayfarerScenario(gameId, {
    id: 'weathered-wayfarer-viewer-reveal-land',
    title: 'Weathered Wayfarer: behind on lands, reveal a land',
    opponentLands: 2,
    instructions: [
      'P2 controls two lands to your one, so activate Weathered Wayfarer for {W}.',
      'Choose Wayfarer Revealed Land from the search.',
    ],
    expectedOutcome:
      'Wayfarer Revealed Land is revealed to every player and put into your hand, and your library is shuffled.',
  });

const weatheredWayfarerBlockedScenario = (gameId: GameId): CardTestScenario =>
  weatheredWayfarerScenario(gameId, {
    id: 'weathered-wayfarer-viewer-equal-lands-blocked',
    title: 'Weathered Wayfarer: equal lands do not unlock it',
    opponentLands: 1,
    instructions: [
      'No opponent controls more lands than your one, so Weathered Wayfarer offers no activation.',
    ],
    expectedOutcome: 'Weathered Wayfarer and the Plains stay untapped and your hand stays empty.',
  });

const LAB_TOKEN_MAKER = card({
  oracleId: 'lab-token-maker',
  name: 'Lab Token Maker',
  typeLine: 'Artifact',
  manaCost: '{1}',
  cmc: 1,
  oracleText: '{1}: Create a 1/1 colorless Servo artifact creature token.',
});
const LAB_IDOL_PAGE = card({
  oracleId: 'lab-idol-page',
  name: 'Idol Drawn Page',
  typeLine: 'Creature — Secret',
});

function idolDrawScenario(gameId: GameId): CardTestScenario {
  const idol = pinnedFrom(MARCHESA_BATCH1, 'Idol of Oblivion');
  return pr01Scenario(gameId, {
    id: 'idol-of-oblivion-viewer-token-then-draw',
    title: 'Idol of Oblivion: make a token, then draw',
    instructions: [
      'Idol of Oblivion cannot draw yet: you have not created a token this turn.',
      'Activate Lab Token Maker for {1} to create a Servo, then tap Idol of Oblivion to draw.',
    ],
    expectedOutcome:
      'A Servo token is created, Idol of Oblivion taps, and you draw Idol Drawn Page.',
    oracleSha256: idol.sha256,
    clauseIds: ['idol-of-oblivion-conditional-draw'],
    decks: {
      P1: [idol.card, LAB_TOKEN_MAKER, FOREST, LAB_IDOL_PAGE],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Idol of Oblivion', 'Lab Token Maker', 'Forest'] },
      ],
    },
  });
}

function idolEldraziScenario(gameId: GameId): CardTestScenario {
  const idol = pinnedFrom(MARCHESA_BATCH1, 'Idol of Oblivion');
  const forests = Array.from({ length: 8 }, () => 'Forest');
  return pr01Scenario(gameId, {
    id: 'idol-of-oblivion-viewer-eldrazi',
    title: 'Idol of Oblivion: sacrifice it for a 10/10 Eldrazi',
    instructions: ['Activate {8}, {T}, Sacrifice Idol of Oblivion with your eight Forests.'],
    expectedOutcome:
      'Idol of Oblivion goes to your graveyard and a 10/10 colorless Eldrazi creature token enters.',
    oracleSha256: idol.sha256,
    clauseIds: ['idol-of-oblivion-eldrazi'],
    decks: {
      P1: [idol.card, ...Array.from({ length: 8 }, () => FOREST)],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Idol of Oblivion', ...forests] }],
    },
  });
}

const LAB_WHITE_SOLDIER = card({
  oracleId: 'lab-white-soldier',
  name: 'Lab White Soldier',
  typeLine: 'Creature — Soldier',
  manaCost: '{W}',
  cmc: 1,
  colors: ['W'],
  colorIdentity: ['W'],
  power: '1',
  toughness: '1',
});
const LAB_BURIED_CARD = card({
  oracleId: 'lab-mistveil-buried',
  name: 'Mistveil Buried Card',
  typeLine: 'Creature — Secret',
});
const LAB_LIBRARY_TOP = card({
  oracleId: 'lab-mistveil-top',
  name: 'Mistveil Library Top',
  typeLine: 'Creature — Secret',
});

function mistveilScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    whites: number;
    instructions: string[];
    expectedOutcome: string;
  },
): CardTestScenario {
  const mistveil = pinnedFrom(MARCHESA_BATCH1, 'Mistveil Plains');
  const soldiers = Array.from({ length: spec.whites }, () => LAB_WHITE_SOLDIER);
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: mistveil.sha256,
    clauseIds: ['mistveil-plains-bottom-of-library'],
    decks: {
      P1: [mistveil.card, PLAINS, ...soldiers, LAB_BURIED_CARD, LAB_LIBRARY_TOP],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Mistveil Plains', 'Plains', ...soldiers.map((soldier) => soldier.name)],
        },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Mistveil Buried Card'] }],
    },
  });
}

const mistveilBottomScenario = (gameId: GameId): CardTestScenario =>
  mistveilScenario(gameId, {
    id: 'mistveil-plains-viewer-bottom-of-library',
    title: 'Mistveil Plains: put a graveyard card on the bottom',
    whites: 2,
    instructions: [
      'With two white creatures, activate Mistveil Plains, paying {W} with the Plains.',
      'Target Mistveil Buried Card in your graveyard.',
    ],
    expectedOutcome:
      'Mistveil Buried Card moves to the bottom of your library; Mistveil Library Top is still on top.',
  });

const mistveilBlockedScenario = (gameId: GameId): CardTestScenario =>
  mistveilScenario(gameId, {
    id: 'mistveil-plains-viewer-one-white-blocked',
    title: 'Mistveil Plains: one white permanent does not unlock it',
    whites: 1,
    instructions: ['With one white creature, Mistveil Plains offers no activation.'],
    expectedOutcome: 'Mistveil Buried Card stays in your graveyard.',
  });

const LAB_THRULL = card({
  oracleId: 'lab-thrull',
  name: 'Lab Thrull',
  typeLine: 'Creature — Thrull',
  manaCost: '{B}',
  cmc: 1,
  colors: ['B'],
  colorIdentity: ['B'],
  power: '1',
  toughness: '1',
});

function carrionFeederSacrificeScenario(gameId: GameId): CardTestScenario {
  const feeder = pinnedFrom(MARCHESA_BATCH1, 'Carrion Feeder');
  return pr01Scenario(gameId, {
    id: 'carrion-feeder-viewer-sacrifice',
    title: 'Carrion Feeder: sacrifice another creature, then itself',
    instructions: [
      'Activate Carrion Feeder, sacrificing Lab Thrull: it gets a +1/+1 counter.',
      'Activate it again, sacrificing Carrion Feeder itself.',
    ],
    expectedOutcome:
      'Lab Thrull is sacrificed and Carrion Feeder gets a +1/+1 counter; then Carrion Feeder sacrifices itself and both are in your graveyard.',
    oracleSha256: feeder.sha256,
    clauseIds: ['carrion-feeder-sacrifice-a-creature'],
    decks: {
      P1: [feeder.card, LAB_THRULL, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Carrion Feeder', 'Lab Thrull'] }],
    },
  });
}

function carrionFeederCantBlockScenario(gameId: GameId): CardTestScenario {
  const feeder = pinnedFrom(MARCHESA_BATCH1, 'Carrion Feeder');
  return pr01Scenario(gameId, {
    id: 'carrion-feeder-viewer-cant-block',
    title: "Carrion Feeder: it can't block",
    instructions: [
      "It is P2's turn. P2 attacks you with Lab Ox.",
      'Only Lab Thrull is offered as a blocker; Carrion Feeder never is. Declare no blocks.',
    ],
    expectedOutcome: 'Carrion Feeder is never offered as a blocker; Lab Ox deals 4 damage to you.',
    oracleSha256: feeder.sha256,
    clauseIds: ['carrion-feeder-cant-block'],
    decks: {
      P1: [feeder.card, LAB_THRULL, FOREST],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      currentTurnPlayer: 'P2',
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Carrion Feeder', 'Lab Thrull'] },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
      continueThroughCombat: true,
    },
    decisionProviderOverrides: { P2: attackP1WithEverything },
  });
}

function nullmageShepherdScenario(gameId: GameId): CardTestScenario {
  const shepherd = pinnedFrom(MARCHESA_BATCH1, 'Nullmage Shepherd');
  return pr01Scenario(gameId, {
    id: 'nullmage-shepherd-viewer-tap-four',
    title: 'Nullmage Shepherd: tap itself and three others to destroy an enchantment',
    instructions: [
      "Activate Nullmage Shepherd targeting P2's Lab Hex.",
      'Tap Nullmage Shepherd itself and your three Lab Thrulls to pay the cost.',
    ],
    expectedOutcome:
      'All four of your creatures tap (the Shepherd counts toward the four) and Lab Hex is destroyed.',
    oracleSha256: shepherd.sha256,
    clauseIds: ['nullmage-shepherd-tap-four-destroy'],
    decks: {
      P1: [shepherd.card, LAB_THRULL, LAB_THRULL, LAB_THRULL, FOREST],
      P2: [LAB_HEX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Nullmage Shepherd', 'Lab Thrull', 'Lab Thrull', 'Lab Thrull'],
        },
        { playerId: 'P2', cardNames: ['Lab Hex'] },
      ],
    },
  });
}

const LAB_WIZARD = card({
  oracleId: 'lab-wizard',
  name: 'Lab Wizard',
  typeLine: 'Creature — Human Wizard',
  manaCost: '{U}',
  cmc: 1,
  colors: ['U'],
  colorIdentity: ['U'],
  power: '1',
  toughness: '1',
});
const LAB_SAGE_PAGE = card({
  oracleId: 'lab-sage-page',
  name: 'Sage Drawn Page',
  typeLine: 'Creature — Secret',
});

function sageOfFablesScenario(gameId: GameId): CardTestScenario {
  const sage = pinnedFrom(MARCHESA_BATCH1, 'Sage of Fables');
  return pr01Scenario(gameId, {
    id: 'sage-of-fables-viewer-wizard-counter-draw',
    title: 'Sage of Fables: a Wizard enters with a counter, then pay it to draw',
    instructions: [
      'Cast Lab Wizard; it enters with an additional +1/+1 counter.',
      "Activate Sage of Fables for {2}, removing Lab Wizard's +1/+1 counter, and draw.",
    ],
    expectedOutcome:
      'Lab Wizard enters as a 2/2 with a +1/+1 counter, the counter is removed to pay the cost, and you draw Sage Drawn Page.',
    oracleSha256: sage.sha256,
    clauseIds: ['sage-of-fables-wizard-counter', 'sage-of-fables-remove-counter-draw'],
    decks: {
      P1: [sage.card, ISLAND, ISLAND, ISLAND, LAB_WIZARD, LAB_SAGE_PAGE],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Wizard'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Sage of Fables', 'Island', 'Island', 'Island'] },
      ],
    },
  });
}

function illuminorSzerasScenario(gameId: GameId): CardTestScenario {
  const szeras = pinnedFrom(MARCHESA_BATCH1, 'Illuminor Szeras');
  return pr01Scenario(gameId, {
    id: 'illuminor-szeras-viewer-sacrifice-for-black',
    title: 'Illuminor Szeras: sacrifice a creature for black mana',
    instructions: [
      'Cast Lab Black Ogre ({B}{B}{B}) with no lands: auto-pay taps Illuminor Szeras and sacrifices Lab Ox (mana value 4).',
    ],
    expectedOutcome:
      'Lab Ox is sacrificed for four black mana, Lab Black Ogre resolves, and Illuminor Szeras is tapped.',
    oracleSha256: szeras.sha256,
    clauseIds: ['illuminor-szeras-sacrifice-for-black'],
    decks: {
      P1: [szeras.card, LAB_OX, LAB_BLACK_OGRE, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Black Ogre'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Illuminor Szeras', 'Lab Ox'] }],
    },
  });
}

const LAB_PEEMA_PAGE = card({
  oracleId: 'lab-peema-page',
  name: 'Peema Drawn Page',
  typeLine: 'Creature — Secret',
});

function peemaExhaustScenario(gameId: GameId): CardTestScenario {
  const peema = pinnedFrom(MARCHESA_BATCH1, 'Peema Trailblazer');
  return pr01Scenario(gameId, {
    id: 'peema-trailblazer-viewer-exhaust',
    title: 'Peema Trailblazer: exhaust for counters and cards',
    instructions: [
      'With six energy, activate the exhaust ability (no tap needed).',
      'It gets two +1/+1 counters, then you draw five cards (its new power). The ability is then gone.',
    ],
    expectedOutcome:
      'Peema Trailblazer becomes 5/5, you draw five Peema Drawn Pages, you have no energy left, and the exhaust ability is never offered again.',
    oracleSha256: peema.sha256,
    clauseIds: ['peema-trailblazer-exhaust'],
    decks: {
      P1: [peema.card, ...Array.from({ length: 6 }, () => LAB_PEEMA_PAGE)],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Peema Trailblazer'] }],
      energy: [{ playerId: 'P1', amount: 6 }],
    },
  });
}

function peemaCombatEnergyScenario(gameId: GameId): CardTestScenario {
  const peema = pinnedFrom(MARCHESA_BATCH1, 'Peema Trailblazer');
  return pr01Scenario(gameId, {
    id: 'peema-trailblazer-viewer-combat-energy',
    title: 'Peema Trailblazer: combat damage gives energy',
    instructions: [
      'Peema Trailblazer shows trample. Attack P2 with it; nobody blocks.',
      'Trample damage assignment past a blocker stays engine-only: the viewer has no damage-split control.',
    ],
    expectedOutcome: 'P2 takes 3 damage and you get three energy.',
    oracleSha256: peema.sha256,
    clauseIds: ['peema-trailblazer-combat-energy', 'peema-trailblazer-trample'],
    decks: { P1: [peema.card, FOREST], P2: PR01_FILLER, P3: PR01_FILLER, P4: PR01_FILLER },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Peema Trailblazer'] }],
      continueThroughCombat: true,
    },
  });
}

const LAB_GRAVE_CARD_P2 = card({
  oracleId: 'lab-lantern-p2-card',
  name: 'Lantern P2 Card',
  typeLine: 'Creature — Spirit',
});
const LAB_GRAVE_CARD_P3 = card({
  oracleId: 'lab-lantern-p3-card',
  name: 'Lantern P3 Card',
  typeLine: 'Creature — Spirit',
});
const LAB_LANTERN_PAGE = card({
  oracleId: 'lab-lantern-page',
  name: 'Lantern Drawn Page',
  typeLine: 'Creature — Secret',
});

const LAB_ARK_THOPTER = card({
  oracleId: 'lab-ark-thopter',
  name: 'Lab Ark Thopter',
  typeLine: 'Artifact Creature — Thopter',
  manaCost: '{2}',
  cmc: 2,
  power: '2',
  toughness: '2',
});
const LAB_ARK_SPIRIT = card({
  oracleId: 'lab-ark-spirit',
  name: 'Lab Ark Spirit',
  typeLine: 'Creature — Spirit',
  manaCost: '{2}',
  cmc: 2,
  power: '2',
  toughness: '2',
});

function ghostArkScenario(gameId: GameId): CardTestScenario {
  const ark = pinnedFrom(MARCHESA_BATCH1, 'Ghost Ark');
  return pr01Scenario(gameId, {
    id: 'ghost-ark-viewer-crew-and-unearth',
    title: 'Ghost Ark: crew it, then unearth an artifact creature',
    instructions: [
      'Ghost Ark shows flying. Crew it with Lab Giant (Crew 2).',
      'When the crewed trigger resolves, unearth Lab Ark Thopter from your graveyard for {3}.',
      'Lab Ark Spirit is not an artifact, so it gets no unearth.',
    ],
    expectedOutcome:
      'Ghost Ark is a 3/3 flying artifact creature, Lab Giant is tapped, Lab Ark Thopter is on the battlefield with haste, all three Forests are tapped, and Lab Ark Spirit stays in your graveyard.',
    oracleSha256: ark.sha256,
    clauseIds: ['ghost-ark-flying', 'ghost-ark-crewed-unearth', 'ghost-ark-crew'],
    decks: {
      P1: [ark.card, LAB_GIANT, LAB_ARK_THOPTER, LAB_ARK_SPIRIT, FOREST, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Ghost Ark', 'Lab Giant', 'Forest', 'Forest', 'Forest'] },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Ark Thopter', 'Lab Ark Spirit'] }],
    },
  });
}

const LAB_BLUE_MERFOLK = card({
  oracleId: 'lab-blue-merfolk',
  name: 'Lab Blue Merfolk',
  typeLine: 'Creature — Merfolk',
  manaCost: '{U}',
  cmc: 1,
  colors: ['U'],
  power: '1',
  toughness: '1',
});

function flareOfDenialScenario(gameId: GameId): CardTestScenario {
  const flare = pinnedFrom(MARCHESA_BATCH1, 'Flare of Denial');
  return pr01Scenario(gameId, {
    id: 'flare-of-denial-viewer-sacrifice-counter',
    title: "Flare of Denial: sacrifice a blue creature to counter P2's spell",
    instructions: [
      "P2's Lab Pending Spell is on the stack and you have no lands.",
      'Cast Flare of Denial for its alternative cost, sacrificing Lab Blue Merfolk, targeting Lab Pending Spell.',
    ],
    expectedOutcome:
      'Lab Blue Merfolk is sacrificed, Lab Pending Spell is countered, and both cards are in graveyards.',
    oracleSha256: flare.sha256,
    clauseIds: ['flare-of-denial-sacrifice-alternative', 'flare-of-denial-counter'],
    decks: {
      P1: [flare.card, LAB_BLUE_MERFOLK, FOREST],
      P2: [ARCANE_PENDING_SPELL, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Flare of Denial'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Lab Blue Merfolk'] }],
      stack: [{ playerId: 'P2', cardNames: ['Lab Pending Spell'] }],
    },
  });
}

function flareOfMaliceScenario(gameId: GameId): CardTestScenario {
  const flare = pinnedFrom(MARCHESA_BATCH1, 'Flare of Malice');
  return pr01Scenario(gameId, {
    id: 'flare-of-malice-viewer-sacrifice-edict',
    title: 'Flare of Malice: sacrifice a black creature; P2 loses its biggest creature',
    instructions: [
      'You have no lands. Cast Flare of Malice for its alternative cost, sacrificing Lab Black Bear.',
      'P2 controls Lab Ox (mana value 4) and Lab Generic Bear (mana value 1).',
    ],
    expectedOutcome:
      'Lab Black Bear is sacrificed, P2 sacrifices Lab Ox, and Lab Generic Bear stays.',
    oracleSha256: flare.sha256,
    clauseIds: ['flare-of-malice-sacrifice-alternative', 'flare-of-malice-greatest-mana-value'],
    decks: {
      P1: [flare.card, LAB_BLACK_BEAR, FOREST],
      P2: [LAB_OX, LAB_GENERIC_BEAR, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Flare of Malice'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Black Bear'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Generic Bear'] },
      ],
    },
  });
}

const LAB_ZOMBIE = card({
  oracleId: 'lab-zombie',
  name: 'Lab Zombie',
  typeLine: 'Creature — Zombie',
  manaCost: '{1}',
  cmc: 1,
  power: '1',
  toughness: '1',
});

function blasphemousEdictScenario(gameId: GameId): CardTestScenario {
  const edict = pinnedFrom(MARCHESA_BATCH1, 'Blasphemous Edict');
  const zombies = Array.from({ length: 11 }, () => LAB_ZOMBIE);
  return pr01Scenario(gameId, {
    id: 'blasphemous-edict-viewer-pay-b',
    title: 'Blasphemous Edict: pay {B} with thirteen creatures out',
    instructions: [
      'There are thirteen creatures on the battlefield: your Lab Ox and Lab Generic Bear, and P2’s eleven Lab Zombies.',
      'Cast Blasphemous Edict for {B} with your Swamp.',
    ],
    expectedOutcome:
      'Each player sacrifices thirteen creatures: every creature on the battlefield is sacrificed, with no choice to make, and the Swamp is tapped.',
    oracleSha256: edict.sha256,
    clauseIds: ['blasphemous-edict-alternative', 'blasphemous-edict-sacrifice-thirteen'],
    decks: {
      P1: [edict.card, SWAMP, LAB_OX, LAB_GENERIC_BEAR],
      P2: [...zombies, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Blasphemous Edict'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Swamp', 'Lab Ox', 'Lab Generic Bear'] },
        { playerId: 'P2', cardNames: zombies.map((zombie) => zombie.name) },
      ],
    },
  });
}

function dreadReturnScenario(gameId: GameId): CardTestScenario {
  const dread = pinnedFrom(MARCHESA_BATCH1, 'Dread Return');
  const zombies = [LAB_ZOMBIE, LAB_ZOMBIE, LAB_ZOMBIE];
  return pr01Scenario(gameId, {
    id: 'dread-return-viewer-flashback',
    title: 'Dread Return: flash it back by sacrificing three creatures',
    instructions: [
      'Dread Return and Lab Ox are in your graveyard; three Lab Zombies are on the battlefield.',
      'Cast Dread Return from your graveyard for its flashback cost, targeting Lab Ox.',
    ],
    expectedOutcome:
      'The three Lab Zombies are sacrificed, Lab Ox returns to the battlefield, and Dread Return is exiled.',
    oracleSha256: dread.sha256,
    clauseIds: ['dread-return-reanimate', 'dread-return-flashback'],
    decks: {
      P1: [dread.card, LAB_OX, ...zombies, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: zombies.map((zombie) => zombie.name) }],
      graveyard: [{ playerId: 'P1', cardNames: ['Dread Return', 'Lab Ox'] }],
    },
  });
}

function raffinesGuidanceScenario(gameId: GameId): CardTestScenario {
  const guidance = pinnedFrom(MARCHESA_BATCH1, "Raffine's Guidance");
  return pr01Scenario(gameId, {
    id: 'raffines-guidance-viewer-graveyard-recast',
    title: "Raffine's Guidance: cast it from the graveyard for {2}{W}",
    instructions: [
      "Raffine's Guidance is in your graveyard. Cast it from there for {2}{W}, enchanting Lab Ox.",
    ],
    expectedOutcome:
      "Raffine's Guidance enchants Lab Ox, which becomes 5/5, and Plains and both Forests are tapped.",
    oracleSha256: guidance.sha256,
    clauseIds: [
      'raffines-guidance-enchant',
      'raffines-guidance-pump',
      'raffines-guidance-graveyard-recast',
    ],
    decks: {
      P1: [guidance.card, LAB_OX, PLAINS, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Lab Ox', 'Plains', 'Forest', 'Forest'] }],
      graveyard: [{ playerId: 'P1', cardNames: ["Raffine's Guidance"] }],
    },
  });
}

function theirNumberIsLegionScenario(gameId: GameId): CardTestScenario {
  const legion = pinnedFrom(MARCHESA_BATCH1, 'Their Number Is Legion');
  const lands = [SWAMP, SWAMP, SWAMP, SWAMP, FOREST, FOREST];
  return pr01Scenario(gameId, {
    id: 'their-number-is-legion-viewer-graveyard-x',
    title: 'Their Number Is Legion: cast it from the graveyard with X=2',
    instructions: [
      'Their Number Is Legion is in your graveyard. Cast it from there with X=2, paying with your four Swamps and two Forests.',
    ],
    expectedOutcome:
      'Two tapped 2/2 Necron Warrior tokens enter, you gain 2 life (you control two artifacts), and Their Number Is Legion is exiled.',
    oracleSha256: legion.sha256,
    clauseIds: ['their-number-is-legion-tokens-and-life', 'their-number-is-legion-graveyard-cast'],
    decks: { P1: [legion.card, ...lands], P2: PR01_FILLER, P3: PR01_FILLER, P4: PR01_FILLER },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: lands.map((land) => land.name) }],
      graveyard: [{ playerId: 'P1', cardNames: ['Their Number Is Legion'] }],
    },
  });
}

const LAB_ANRAKYR_RELIC = card({
  oracleId: 'lab-anrakyr-relic',
  name: 'Lab Anrakyr Relic',
  typeLine: 'Artifact',
  manaCost: '{3}',
  cmc: 3,
});
const LAB_ANRAKYR_GOLEM = card({
  oracleId: 'lab-anrakyr-golem',
  name: 'Lab Anrakyr Golem',
  typeLine: 'Artifact Creature — Golem',
  manaCost: '{4}',
  cmc: 4,
  power: '3',
  toughness: '3',
});

function anrakyrScenario(gameId: GameId): CardTestScenario {
  const anrakyr = pinnedFrom(MARCHESA_BATCH1, 'Anrakyr the Traveller');
  return pr01Scenario(gameId, {
    id: 'anrakyr-the-traveller-viewer-cast-for-life',
    title: 'Anrakyr the Traveller: attack, then cast an artifact for life',
    instructions: [
      'Attack P2 with Anrakyr the Traveller and use its trigger.',
      'Cast Lab Anrakyr Golem from your graveyard by paying 4 life (Lab Anrakyr Relic in hand would cost 3).',
    ],
    expectedOutcome:
      'You pay 4 life (40 → 36) and spend no mana; Lab Anrakyr Golem enters the battlefield, and Anrakyr deals 4 damage to P2.',
    oracleSha256: anrakyr.sha256,
    clauseIds: ['anrakyr-the-traveller-cast-for-life'],
    decks: {
      P1: [anrakyr.card, LAB_ANRAKYR_RELIC, LAB_ANRAKYR_GOLEM, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Anrakyr Relic'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Anrakyr the Traveller'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Anrakyr Golem'] }],
      continueThroughCombat: true,
    },
  });
}

function toxicDelugeScenario(gameId: GameId): CardTestScenario {
  const deluge = pinnedFrom(MARCHESA_BATCH1, 'Toxic Deluge');
  return pr01Scenario(gameId, {
    id: 'toxic-deluge-viewer-pay-two-life',
    title: 'Toxic Deluge: pay 2 life for -2/-2',
    instructions: [
      'Cast Toxic Deluge with X=2, paying {2}{B} with your Swamp and Forests and 2 life.',
    ],
    expectedOutcome:
      "You go to 38 life as you cast it; P2's Lab Zombie dies, and Lab Ox and Lab Giant survive as 2/2s until end of turn.",
    oracleSha256: deluge.sha256,
    clauseIds: ['toxic-deluge-pay-x-life', 'toxic-deluge-minus-x'],
    decks: {
      P1: [deluge.card, SWAMP, FOREST, FOREST, LAB_OX],
      P2: [LAB_ZOMBIE, LAB_GIANT, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Toxic Deluge'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Swamp', 'Forest', 'Forest', 'Lab Ox'] },
        { playerId: 'P2', cardNames: ['Lab Zombie', 'Lab Giant'] },
      ],
    },
  });
}

function conclaveTribunalScenario(gameId: GameId): CardTestScenario {
  const tribunal = pinnedFrom(MARCHESA_BATCH1, 'Conclave Tribunal');
  return pr01Scenario(gameId, {
    id: 'conclave-tribunal-viewer-convoke',
    title: 'Conclave Tribunal: convoke with three creatures',
    instructions: [
      'Cast Conclave Tribunal: your Plains pays {W} and your three creatures convoke for {3}.',
      "Its enters trigger exiles P2's Lab Anrakyr Relic.",
    ],
    expectedOutcome:
      "Plains, Lab Ox, Lab Generic Bear and Lab Zombie are tapped, and P2's Lab Anrakyr Relic is exiled.",
    oracleSha256: tribunal.sha256,
    clauseIds: ['conclave-tribunal-convoke', 'conclave-tribunal-exile'],
    decks: {
      P1: [tribunal.card, PLAINS, LAB_OX, LAB_GENERIC_BEAR, LAB_ZOMBIE],
      P2: [LAB_ANRAKYR_RELIC, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Conclave Tribunal'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Plains', 'Lab Ox', 'Lab Generic Bear', 'Lab Zombie'] },
        { playerId: 'P2', cardNames: ['Lab Anrakyr Relic'] },
      ],
    },
  });
}

function hourOfReckoningScenario(gameId: GameId): CardTestScenario {
  const hour = pinnedFrom(MARCHESA_BATCH1, 'Hour of Reckoning');
  return pr01Scenario(gameId, {
    id: 'hour-of-reckoning-viewer-convoke',
    title: 'Hour of Reckoning: three Plains and four convoked creatures',
    instructions: [
      'Cast Hour of Reckoning: three Plains pay {W}{W}{W} and your four creatures convoke for {4}.',
    ],
    expectedOutcome:
      "Every nontoken creature is destroyed, your four convoked creatures and P2's Lab Anrakyr Golem included.",
    oracleSha256: hour.sha256,
    clauseIds: ['hour-of-reckoning-convoke', 'hour-of-reckoning-destroy'],
    decks: {
      P1: [hour.card, PLAINS, PLAINS, PLAINS, LAB_OX, LAB_GENERIC_BEAR, LAB_ZOMBIE, LAB_GIANT],
      P2: [LAB_ANRAKYR_GOLEM, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Hour of Reckoning'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: [
            'Plains',
            'Plains',
            'Plains',
            'Lab Ox',
            'Lab Generic Bear',
            'Lab Zombie',
            'Lab Giant',
          ],
        },
        { playerId: 'P2', cardNames: ['Lab Anrakyr Golem'] },
      ],
    },
  });
}

const LAB_KILLIAN_BOLT = card({
  oracleId: 'lab-killian-bolt',
  name: 'Lab Killian Bolt',
  typeLine: 'Instant',
  manaCost: '{2}{R}',
  cmc: 3,
  colors: ['R'],
  oracleText: 'Lab Killian Bolt deals 2 damage to any target.',
});

function killianScenario(gameId: GameId): CardTestScenario {
  const killian = pinnedFrom(MARCHESA_BATCH1, 'Killian, Ink Duelist');
  return pr01Scenario(gameId, {
    id: 'killian-ink-duelist-viewer-reduced-bolt',
    title: 'Killian, Ink Duelist: a {2}{R} bolt at a creature for {R}',
    instructions: [
      "With only a Mountain, cast Lab Killian Bolt ({2}{R}) at P2's Lab Ox: targeting a creature, it costs {2} less.",
    ],
    expectedOutcome:
      'Lab Killian Bolt costs only {R}; Lab Ox takes 2 damage. P2 is not offered as a target at that price.',
    oracleSha256: killian.sha256,
    clauseIds: ['killian-ink-duelist-reduction'],
    decks: {
      P1: [killian.card, LAB_KILLIAN_BOLT, MOUNTAIN],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Killian Bolt'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['Killian, Ink Duelist', 'Mountain'] },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
    },
  });
}

const LAB_DRAGON = card({
  oracleId: 'lab-dragon',
  name: 'Lab Dragon',
  typeLine: 'Creature — Dragon',
  manaCost: '{4}{R}',
  cmc: 5,
  colors: ['R'],
  power: '4',
  toughness: '4',
});

function dragonkinBerserkerScenario(gameId: GameId): CardTestScenario {
  const berserker = pinnedFrom(MARCHESA_BATCH1, 'Dragonkin Berserker');
  return pr01Scenario(gameId, {
    id: 'dragonkin-berserker-viewer-reduced-boast',
    title: 'Dragonkin Berserker: attack, then Boast for {2}{R}',
    instructions: [
      'Attack P2 with Dragonkin Berserker only.',
      'After attackers are declared, activate its Boast. You control two Lab Dragons, so it costs {2}{R}: pay with your Mountain and Forests.',
    ],
    expectedOutcome:
      'A 5/5 flying Dragon token is created, all three lands are tapped, and P2 takes 2 first-strike damage.',
    oracleSha256: berserker.sha256,
    clauseIds: [
      'dragonkin-berserker-first-strike',
      'dragonkin-berserker-boast-reduction',
      'dragonkin-berserker-boast',
    ],
    decks: {
      P1: [berserker.card, LAB_DRAGON, LAB_DRAGON, MOUNTAIN, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: [
            'Dragonkin Berserker',
            'Lab Dragon',
            'Lab Dragon',
            'Mountain',
            'Forest',
            'Forest',
          ],
        },
      ],
      continueThroughCombat: true,
    },
  });
}

const LAB_NECRON_OVERLORD = card({
  oracleId: 'lab-necron-overlord',
  name: 'Lab Necron Overlord',
  typeLine: 'Legendary Artifact Creature — Necron Noble',
  manaCost: '{3}{B}',
  cmc: 4,
  colors: ['B'],
  colorIdentity: ['B'],
  power: '3',
  toughness: '3',
});
const LAB_UNEARTH_WARRIOR = card({
  oracleId: 'lab-unearth-warrior',
  name: 'Lab Unearth Warrior',
  typeLine: 'Artifact Creature — Necron Warrior',
  manaCost: '{3}',
  cmc: 3,
  power: '2',
  toughness: '2',
  oracleText: 'Unearth {3}',
});

function convergenceOfDominionScenario(gameId: GameId): CardTestScenario {
  const convergence = pinnedFrom(MARCHESA_BATCH1, 'Convergence of Dominion');
  return pr01Scenario(gameId, {
    id: 'convergence-of-dominion-viewer-cheap-unearth',
    title: 'Convergence of Dominion: Unearth {3} for {1}',
    instructions: [
      'Your commander, Lab Necron Overlord, is on the battlefield, so graveyard abilities cost {2} less.',
      'Unearth Lab Unearth Warrior from your graveyard, paying {1} with your Forest.',
    ],
    expectedOutcome: 'Lab Unearth Warrior returns with haste for {1}; only the Forest is tapped.',
    oracleSha256: convergence.sha256,
    clauseIds: ['convergence-of-dominion-reduction'],
    decks: {
      P1: [convergence.card, LAB_UNEARTH_WARRIOR, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    commanders: { P1: [LAB_NECRON_OVERLORD] },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Lab Necron Overlord', 'Convergence of Dominion', 'Forest'] },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Unearth Warrior'] }],
    },
  });
}

function koglaYidaroScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    instructions: string[];
    expectedOutcome: string;
    clauseIds: string[];
    inHandOnly: boolean;
  },
): CardTestScenario {
  const kogla = pinnedFrom(COVERAGE_PR02, 'Kogla and Yidaro');
  const lands = [MOUNTAIN, MOUNTAIN, FOREST, FOREST, FOREST, FOREST];
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: kogla.sha256,
    clauseIds: spec.clauseIds,
    decks: {
      P1: [kogla.card, ...lands, LAB_ZOMBIE],
      P2: [LAB_OX, LAB_ANRAKYR_RELIC, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Kogla and Yidaro'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: spec.inHandOnly
            ? ['Mountain', 'Forest', 'Forest', 'Forest']
            : lands.map((land) => land.name),
        },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Anrakyr Relic'] },
      ],
    },
  });
}

const koglaYidaroFightScenario = (gameId: GameId): CardTestScenario =>
  koglaYidaroScenario(gameId, {
    id: 'kogla-and-yidaro-viewer-enter-fight',
    title: "Kogla and Yidaro: enter and fight P2's Lab Ox",
    instructions: [
      'Cast Kogla and Yidaro with your six lands.',
      "Choose its second mode and fight P2's Lab Ox.",
    ],
    expectedOutcome: 'Lab Ox dies, and Kogla and Yidaro has 4 damage marked.',
    clauseIds: ['kogla-and-yidaro-enters-modes'],
    inHandOnly: false,
  });

const koglaYidaroDiscardScenario = (gameId: GameId): CardTestScenario =>
  koglaYidaroScenario(gameId, {
    id: 'kogla-and-yidaro-viewer-discard',
    title: "Kogla and Yidaro: discard it to destroy P2's artifact",
    instructions: [
      "Activate Kogla and Yidaro's ability from your hand for {2}{R}{G}, targeting P2's Lab Anrakyr Relic.",
    ],
    expectedOutcome:
      'Lab Anrakyr Relic is destroyed, Kogla and Yidaro is shuffled into your library, and you draw a card.',
    clauseIds: ['kogla-and-yidaro-discard'],
    inHandOnly: true,
  });

function grimHaruspexScenario(gameId: GameId): CardTestScenario {
  const haruspex = pinnedFrom(MARCHESA_BATCH1, 'Grim Haruspex');
  return pr01Scenario(gameId, {
    id: 'grim-haruspex-viewer-morph',
    title: 'Grim Haruspex: cast it face down, turn it face up, then draw',
    instructions: [
      'Cast Grim Haruspex face down for {3}.',
      'Turn it face up for {B}.',
      'Cast Lab Doom on your Lab Zombie.',
    ],
    expectedOutcome: 'Grim Haruspex is a face-up 3/2, Lab Zombie dies, and you draw a card.',
    oracleSha256: haruspex.sha256,
    clauseIds: ['grim-haruspex-morph', 'grim-haruspex-draw'],
    decks: {
      P1: [haruspex.card, LAB_DOOM, LAB_ZOMBIE, SWAMP, SWAMP, SWAMP, SWAMP, SWAMP, SWAMP, SWAMP],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Grim Haruspex', 'Lab Doom'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Lab Zombie'],
        },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
    },
  });
}

const LAB_FORETELL_BOLT = card({
  oracleId: 'lab-foretell-bolt',
  name: 'Lab Foretell Bolt',
  typeLine: 'Instant',
  manaCost: '{2}{R}',
  cmc: 3,
  colors: ['R'],
  oracleText: 'Lab Foretell Bolt deals 2 damage to any target.',
});

function dreamDevourerScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    instructions: string[];
    expectedOutcome: string;
    clauseIds: string[];
    alreadyForetold: boolean;
  },
): CardTestScenario {
  const devourer = pinnedFrom(MARCHESA_BATCH1, 'Dream Devourer');
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: devourer.sha256,
    clauseIds: spec.clauseIds,
    decks: {
      P1: [devourer.card, LAB_FORETELL_BOLT, MOUNTAIN, MOUNTAIN],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: spec.alreadyForetold ? [] : ['Lab Foretell Bolt'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: spec.alreadyForetold
            ? ['Dream Devourer', 'Mountain']
            : ['Dream Devourer', 'Mountain', 'Mountain'],
        },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
      ...(spec.alreadyForetold
        ? { foretold: [{ playerId: 'P1', cardNames: ['Lab Foretell Bolt'], reduction: 2 }] }
        : {}),
    },
  });
}

const dreamDevourerForetellScenario = (gameId: GameId): CardTestScenario =>
  dreamDevourerScenario(gameId, {
    id: 'dream-devourer-viewer-foretell',
    title: 'Dream Devourer: foretell a card for {2}',
    instructions: ['Foretell Lab Foretell Bolt from your hand for {2}.'],
    expectedOutcome:
      'Lab Foretell Bolt is exiled face down, and Dream Devourer gets +2/+0 until end of turn.',
    clauseIds: ['dream-devourer-grant', 'dream-devourer-pump'],
    alreadyForetold: false,
  });

const dreamDevourerForetoldCastScenario = (gameId: GameId): CardTestScenario =>
  dreamDevourerScenario(gameId, {
    id: 'dream-devourer-viewer-foretold-cast',
    title: 'Dream Devourer: cast a foretold card for {R}',
    instructions: [
      'Lab Foretell Bolt was foretold last turn. Cast it from exile for {R}, targeting P2.',
    ],
    expectedOutcome: 'Lab Foretell Bolt deals 2 damage to P2.',
    clauseIds: ['dream-devourer-grant'],
    alreadyForetold: true,
  });

function changingLoyaltyScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    instructions: string[];
    expectedOutcome: string;
    clauseIds: string[];
    withDoom: boolean;
  },
): CardTestScenario {
  const loyalty = pinnedFrom(MARCHESA_BATCH1, 'Changing Loyalty');
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: loyalty.sha256,
    clauseIds: spec.clauseIds,
    decks: {
      P1: [loyalty.card, LAB_DOOM, SWAMP, SWAMP, SWAMP, SWAMP],
      P2: [LAB_OX, LAB_GENERIC_BEAR, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [
        {
          playerId: 'P1',
          cardNames: spec.withDoom ? ['Changing Loyalty', 'Lab Doom'] : ['Changing Loyalty'],
        },
      ],
      battlefield: [
        { playerId: 'P1', cardNames: ['Swamp', 'Swamp', 'Swamp', 'Swamp'] },
        { playerId: 'P2', cardNames: ['Lab Ox', 'Lab Generic Bear'] },
      ],
    },
  });
}

const changingLoyaltyReplicateScenario = (gameId: GameId): CardTestScenario =>
  changingLoyaltyScenario(gameId, {
    id: 'changing-loyalty-viewer-replicate',
    title: "Changing Loyalty: replicate once onto both of P2's creatures",
    instructions: [
      "Cast Changing Loyalty with replicate 1 for {3}{B}, targeting P2's Lab Ox.",
      "Choose P2's Lab Generic Bear as the copy's target.",
    ],
    expectedOutcome:
      'Changing Loyalty enchants Lab Ox, and its copy resolves into a Changing Loyalty token enchanting Lab Generic Bear.',
    clauseIds: ['changing-loyalty-replicate', 'changing-loyalty-enchant'],
    withDoom: false,
  });

const changingLoyaltyStealScenario = (gameId: GameId): CardTestScenario =>
  changingLoyaltyScenario(gameId, {
    id: 'changing-loyalty-viewer-steal',
    title: "Changing Loyalty: enchant P2's Lab Ox, destroy it, and take it",
    instructions: ["Cast Changing Loyalty for {1}{B} on P2's Lab Ox.", 'Cast Lab Doom on Lab Ox.'],
    expectedOutcome:
      'Lab Ox dies and returns to the battlefield under your control; Changing Loyalty goes to your graveyard.',
    clauseIds: ['changing-loyalty-enchant', 'changing-loyalty-steal'],
    withDoom: true,
  });

function soulGuideLanternScenario(
  gameId: GameId,
  spec: {
    id: string;
    title: string;
    instructions: string[];
    expectedOutcome: string;
    clauseIds: string[];
    inHand: boolean;
  },
): CardTestScenario {
  const lantern = pinnedFrom(MARCHESA_BATCH1, 'Soul-Guide Lantern');
  return pr01Scenario(gameId, {
    id: spec.id,
    title: spec.title,
    instructions: spec.instructions,
    expectedOutcome: spec.expectedOutcome,
    oracleSha256: lantern.sha256,
    clauseIds: spec.clauseIds,
    decks: {
      P1: [lantern.card, FOREST, LAB_LANTERN_PAGE],
      P2: [LAB_GRAVE_CARD_P2, FOREST, FOREST],
      P3: [LAB_GRAVE_CARD_P3, FOREST, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: spec.inHand ? [{ playerId: 'P1', cardNames: ['Soul-Guide Lantern'] }] : [],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: spec.inHand ? ['Forest'] : ['Soul-Guide Lantern', 'Forest'],
        },
      ],
      graveyard: [
        { playerId: 'P2', cardNames: ['Lantern P2 Card'] },
        { playerId: 'P3', cardNames: ['Lantern P3 Card'] },
      ],
    },
  });
}

const soulGuideLanternEntersScenario = (gameId: GameId): CardTestScenario =>
  soulGuideLanternScenario(gameId, {
    id: 'soul-guide-lantern-viewer-enters-exile',
    title: "Soul-Guide Lantern: enter and exile a card from P2's graveyard",
    instructions: [
      'Cast Soul-Guide Lantern with your Forest.',
      "Its enters trigger targets a card in any graveyard: choose P2's Lantern P2 Card.",
    ],
    expectedOutcome: "Lantern P2 Card is exiled; P3's graveyard is untouched.",
    clauseIds: ['soul-guide-lantern-enters-exile'],
    inHand: true,
  });

const soulGuideLanternExileScenario = (gameId: GameId): CardTestScenario =>
  soulGuideLanternScenario(gameId, {
    id: 'soul-guide-lantern-viewer-exile-graveyards',
    title: "Soul-Guide Lantern: sacrifice it to exile each opponent's graveyard",
    instructions: ["Activate {T}, Sacrifice Soul-Guide Lantern: Exile each opponent's graveyard."],
    expectedOutcome:
      "P2's and P3's graveyards are exiled, and Soul-Guide Lantern is in your graveyard. No mana is spent.",
    clauseIds: ['soul-guide-lantern-exile-graveyards'],
    inHand: false,
  });

const soulGuideLanternDrawScenario = (gameId: GameId): CardTestScenario =>
  soulGuideLanternScenario(gameId, {
    id: 'soul-guide-lantern-viewer-draw',
    title: 'Soul-Guide Lantern: pay {1} and sacrifice it to draw',
    instructions: [
      'Activate {1}, {T}, Sacrifice Soul-Guide Lantern: Draw a card, paying with your Forest.',
    ],
    expectedOutcome:
      'You draw Lantern Drawn Page and the Lantern is in your graveyard; the opponents keep their graveyards.',
    clauseIds: ['soul-guide-lantern-draw'],
    inHand: false,
  });

function mosswortCastingScenario(
  gameId: GameId,
  hiddenLand = false,
  spellFace = false,
): CardTestScenario {
  const bridge = pinnedFrom(HIDEAWAY_CASTING, 'Mosswort Bridge');
  const wake = card({
    oracleId: 'lab-hideaway-wake',
    name: 'Lab Wake',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'Untap target permanent.',
  });
  const counter = card({
    oracleId: 'lab-hideaway-witness',
    name: 'Lab Witness',
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 0 life.',
  });
  const titan = card({
    oracleId: 'lab-hidden-titan',
    name: 'Lab Hidden Titan',
    typeLine: 'Creature — Giant',
    manaCost: '{7}',
    cmc: 7,
    power: '7',
    toughness: '7',
  });
  const face = JSON.parse(
    readFileSync('packages/engine/tests/fixtures/selected-spell-faces-oracle.json', 'utf8'),
  ).cards.find((row: { card: OracleCard }) => row.card.name.startsWith('Foulmire Knight')) as {
    card: OracleCard;
    sha256: string;
  };
  if (createHash('sha256').update(JSON.stringify(face.card)).digest('hex') !== face.sha256)
    throw new Error('Free face Oracle fixture drift');
  return pr01Scenario(gameId, {
    id: spellFace
      ? 'mosswort-viewer-free-adventure-face'
      : hiddenLand
        ? 'mosswort-viewer-land-play-limit'
        : 'mosswort-viewer-free-cast-stack',
    title: spellFace
      ? 'Mosswort Bridge: cast a hidden Adventure spell face'
      : hiddenLand
        ? 'Mosswort Bridge: a hidden land still needs a land play'
        : 'Mosswort Bridge: cast a hidden permanent on the spell stack',
    instructions: [
      'Play Mosswort Bridge and hide ' +
        (spellFace ? 'Foulmire Knight.' : hiddenLand ? 'a Forest.' : 'Lab Hidden Titan.'),
      'Cast Lab Wake targeting the Bridge, then activate its hideaway ability using the Forest.',
      spellFace
        ? 'Choose to play Foulmire Knight, then configure Profane Insight. Its Instant spell resolves on the normal stack.'
        : hiddenLand
          ? 'The land play was used by Mosswort Bridge, so the hidden Forest cannot be played.'
          : 'Choose to play Lab Hidden Titan; its spell waits on the stack. Pass priority to let it resolve.',
    ],
    expectedOutcome: spellFace
      ? 'Profane Insight draws one card, loses one life, and leaves its physical card on Adventure in exile.'
      : hiddenLand
        ? 'The hidden Forest remains in exile and no second land is played.'
        : 'Lab Hidden Titan is cast exactly once and resolves as a 7/7 creature.',
    oracleSha256: bridge.sha256,
    clauseIds: spellFace
      ? ['mosswort-bridge-hideaway', 'mosswort-bridge-free-play', 'profane-insight-free-face']
      : ['mosswort-bridge-hideaway', 'mosswort-bridge-free-play'],
    decks: {
      P1: [
        bridge.card,
        wake,
        counter,
        LAB_OX,
        LAB_OX,
        LAB_OX,
        FOREST,
        spellFace ? face.card : hiddenLand ? FOREST : titan,
        LAB_SERVO,
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Mosswort Bridge', 'Lab Wake', 'Lab Witness'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Lab Ox', 'Lab Ox', 'Lab Ox', 'Forest'] }],
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Coverage PR03 (docs/plans/card-coverage-chunks.md): zone-change history, last-known
// information, death and return.
// ---------------------------------------------------------------------------------------------

/**
 * An opponent seat that casts `spell` the first time it may, aiming every target slot at P1 when
 * P1 is a legal choice (otherwise at the slot's first option), and otherwise passes.
 */
function castWhenAble(spell: string): DecisionProvider {
  let cast = false;
  return {
    decide(request) {
      const action = cast
        ? undefined
        : request.legalActions.find((candidate) =>
            candidate.description.startsWith(`Cast ${spell}`),
          );
      if (action !== undefined) {
        cast = true;
        return {
          requestId: request.requestId,
          actionId: action.id,
          targets: (action.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: slot.options.includes('P1') ? 'P1' : (slot.options[0] as string),
          })),
        };
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
    },
  };
}

function triarchPraetorianScenario(gameId: GameId): CardTestScenario {
  const praetorian = pinnedFrom(MARCHESA_BATCH1, 'Triarch Praetorian');
  const swamps = [SWAMP, SWAMP, SWAMP, SWAMP, SWAMP];
  return pr01Scenario(gameId, {
    id: 'triarch-praetorian-viewer-unearth',
    title: 'Triarch Praetorian: unearth it to draw two cards',
    instructions: [
      'Triarch Praetorian is in your graveyard and five Swamps are on the battlefield.',
      'Activate its unearth ability from your graveyard for {4}{B}.',
    ],
    expectedOutcome:
      'Triarch Praetorian returns with haste, its enters-from-a-graveyard trigger draws Lab Ox and Lab Zombie and costs 2 life, and it is exiled at the next end step.',
    oracleSha256: praetorian.sha256,
    clauseIds: [
      'triarch-praetorian-flying',
      'triarch-praetorian-dynastic-codes',
      'triarch-praetorian-unearth',
    ],
    decks: {
      P1: [praetorian.card, ...swamps, LAB_OX, LAB_ZOMBIE],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: swamps.map((swamp) => swamp.name) }],
      graveyard: [{ playerId: 'P1', cardNames: ['Triarch Praetorian'] }],
    },
  });
}

function canoptekTombSentinelScenario(gameId: GameId): CardTestScenario {
  const sentinel = pinnedFrom(MARCHESA_BATCH1, 'Canoptek Tomb Sentinel');
  const swamps = Array.from({ length: 7 }, () => SWAMP);
  return pr01Scenario(gameId, {
    id: 'canoptek-tomb-sentinel-viewer-unearth-exile',
    title: "Canoptek Tomb Sentinel: unearth it to exile P2's Lab Ox",
    instructions: [
      'Canoptek Tomb Sentinel is in your graveyard and seven Swamps are on the battlefield.',
      'Activate its unearth ability for {7}, then target Lab Ox with its enters-from-a-graveyard trigger.',
    ],
    expectedOutcome:
      'Canoptek Tomb Sentinel returns with haste and its trigger exiles Lab Ox; it would exile nothing if you chose no target.',
    oracleSha256: sentinel.sha256,
    clauseIds: [
      'canoptek-tomb-sentinel-vigilance',
      'canoptek-tomb-sentinel-exile-cannon',
      'canoptek-tomb-sentinel-unearth',
    ],
    decks: {
      P1: [sentinel.card, ...swamps],
      P2: [LAB_OX, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: swamps.map((swamp) => swamp.name) },
        { playerId: 'P2', cardNames: ['Lab Ox'] },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Canoptek Tomb Sentinel'] }],
    },
  });
}

function glenElendraArchmageScenario(gameId: GameId): CardTestScenario {
  const archmage = pinnedFrom(MARCHESA_BATCH1, 'Glen Elendra Archmage');
  return pr01Scenario(gameId, {
    id: 'glen-elendra-archmage-viewer-counter-persist',
    title: "Glen Elendra Archmage: counter P3's spell, then persist",
    instructions: [
      "P3's Lab Pending Spell is on the stack; Glen Elendra Archmage and an Island are on your battlefield.",
      'Activate the Archmage for {U}, sacrificing it, and target Lab Pending Spell.',
    ],
    expectedOutcome:
      'Lab Pending Spell is countered, and persist returns Glen Elendra Archmage as a 1/1 with a -1/-1 counter.',
    oracleSha256: archmage.sha256,
    clauseIds: [
      'glen-elendra-archmage-flying',
      'glen-elendra-archmage-counter',
      'glen-elendra-archmage-persist',
    ],
    decks: {
      P1: [archmage.card, ISLAND, ISLAND],
      P2: PR01_FILLER,
      P3: [ARCANE_PENDING_SPELL, FOREST, FOREST],
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Glen Elendra Archmage', 'Island'] }],
      stack: [{ playerId: 'P3', cardNames: ['Lab Pending Spell'] }],
    },
  });
}

function flayerOfTheHateboundScenario(gameId: GameId): CardTestScenario {
  const flayer = pinnedFrom(MARCHESA_BATCH1, 'Flayer of the Hatebound');
  return pr01Scenario(gameId, {
    id: 'flayer-of-the-hatebound-viewer-undying-damage',
    title: 'Flayer of the Hatebound: destroy it, undying, deal 5 to P2',
    instructions: [
      'Flayer of the Hatebound and two Swamps are on your battlefield; Lab Doom is in your hand.',
      'Cast Lab Doom on Flayer of the Hatebound.',
      'Undying returns it; aim its enters-from-your-graveyard trigger at P2.',
    ],
    expectedOutcome:
      'Flayer of the Hatebound returns with a +1/+1 counter as a 5/3, and deals 5 damage to P2.',
    oracleSha256: flayer.sha256,
    clauseIds: ['flayer-of-the-hatebound-undying', 'flayer-of-the-hatebound-graveyard-damage'],
    decks: {
      P1: [flayer.card, LAB_DOOM, SWAMP, SWAMP],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Flayer of the Hatebound', 'Swamp', 'Swamp'] }],
    },
  });
}

function kambalScenario(gameId: GameId): CardTestScenario {
  const kambal = pinnedFrom(MARCHESA_BATCH1, 'Kambal, Consul of Allocation');
  return pr01Scenario(gameId, {
    id: 'kambal-viewer-opponent-noncreature-spell',
    title: "Kambal, Consul of Allocation: tax P2's noncreature spell",
    instructions: [
      'Kambal is on your battlefield; Lab Pending Spell is in your hand.',
      'Cast Lab Pending Spell: your own noncreature spell does not trigger Kambal.',
      'P2 casts Lab Shock at you when it gets priority.',
    ],
    expectedOutcome:
      "Only P2's Lab Shock triggers Kambal: P2 loses 2 life and you gain 2 life, then Lab Shock deals 2 damage to you.",
    oracleSha256: kambal.sha256,
    clauseIds: ['kambal-opponent-noncreature-tax'],
    decks: {
      P1: [kambal.card, ARCANE_PENDING_SPELL, FOREST, LAB_OX],
      P2: [LAB_SHOCK, MOUNTAIN, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [
        { playerId: 'P1', cardNames: ['Lab Pending Spell'] },
        { playerId: 'P2', cardNames: ['Lab Shock'] },
      ],
      battlefield: [
        { playerId: 'P1', cardNames: ['Kambal, Consul of Allocation', 'Forest'] },
        { playerId: 'P2', cardNames: ['Mountain'] },
      ],
    },
    decisionProviderOverrides: { P2: castWhenAble('Lab Shock') },
  });
}

function gleefulArsonistScenario(gameId: GameId): CardTestScenario {
  const arsonist = pinnedFrom(MARCHESA_BATCH1, 'Gleeful Arsonist');
  return pr01Scenario(gameId, {
    id: 'gleeful-arsonist-viewer-burn-and-undying',
    title: 'Gleeful Arsonist: burn P2 for casting, then undying',
    instructions: [
      'Gleeful Arsonist and two Swamps are on your battlefield; Lab Doom is in your hand.',
      'Cast Lab Doom on Gleeful Arsonist. P2 responds by casting Lab Shock at you.',
    ],
    expectedOutcome:
      'Lab Shock triggers the Arsonist, which deals 1 damage to P2; Lab Doom then destroys it and undying returns it as a 2/3 with a +1/+1 counter.',
    oracleSha256: arsonist.sha256,
    clauseIds: ['gleeful-arsonist-burn-caster', 'gleeful-arsonist-undying'],
    decks: {
      P1: [arsonist.card, LAB_DOOM, SWAMP, SWAMP, LAB_OX],
      P2: [LAB_SHOCK, MOUNTAIN, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [
        { playerId: 'P1', cardNames: ['Lab Doom'] },
        { playerId: 'P2', cardNames: ['Lab Shock'] },
      ],
      battlefield: [
        { playerId: 'P1', cardNames: ['Gleeful Arsonist', 'Swamp', 'Swamp'] },
        { playerId: 'P2', cardNames: ['Mountain'] },
      ],
    },
    decisionProviderOverrides: { P2: castWhenAble('Lab Shock') },
  });
}

function shardOfTheNightbringerScenario(gameId: GameId): CardTestScenario {
  const shard = pinnedFrom(MARCHESA_BATCH1, 'Shard of the Nightbringer');
  const swamps = Array.from({ length: 8 }, () => SWAMP);
  return pr01Scenario(gameId, {
    id: 'shard-of-the-nightbringer-viewer-cast-drain',
    title: "Shard of the Nightbringer: cast it to drain half of P2's life",
    instructions: [
      'Shard of the Nightbringer is in your hand and eight Swamps are on the battlefield.',
      'Cast it, then target P2 with its if-you-cast-it trigger.',
    ],
    expectedOutcome: 'P2 loses half their life (20) and you gain 20 life.',
    oracleSha256: shard.sha256,
    clauseIds: ['shard-of-the-nightbringer-flying', 'shard-of-the-nightbringer-drain-life'],
    decks: {
      P1: [shard.card, ...swamps],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Shard of the Nightbringer'] }],
      battlefield: [{ playerId: 'P1', cardNames: swamps.map((swamp) => swamp.name) }],
    },
  });
}

function satoruScenario(gameId: GameId): CardTestScenario {
  const satoru = pinnedFrom(MARCHESA_BATCH1, 'Satoru, the Infiltrator');
  const ornithopter = card({
    oracleId: 'lab-satoru-ornithopter',
    name: 'Lab Ornithopter',
    typeLine: 'Artifact Creature — Thopter',
    manaCost: '{0}',
    cmc: 0,
    power: '0',
    toughness: '2',
  });
  return pr01Scenario(gameId, {
    id: 'satoru-viewer-free-cast-draws',
    title: 'Satoru, the Infiltrator: a free creature draws, a paid one does not',
    instructions: [
      'Satoru and a Forest are on your battlefield; Lab Ornithopter ({0}) and Lab Zombie ({1}) are in your hand.',
      'Cast Lab Ornithopter for no mana: Satoru draws a card.',
      'Cast Lab Zombie with the Forest: mana was spent, so Satoru does not draw.',
    ],
    expectedOutcome: 'You draw exactly one card (Lab Ox), from Lab Ornithopter entering.',
    oracleSha256: satoru.sha256,
    clauseIds: ['satoru-menace', 'satoru-uncast-or-free-draw'],
    decks: {
      P1: [satoru.card, ornithopter, LAB_ZOMBIE, FOREST, LAB_OX],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Ornithopter', 'Lab Zombie'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Satoru, the Infiltrator', 'Forest'] }],
    },
  });
}

/** A fully interpreted flashback instant: the PR03 graveyard-cast scenarios cast it from there. */
const LAB_FLASH_BOLT = card({
  oracleId: 'lab-keeper-flash-bolt',
  name: 'Lab Flash Bolt',
  typeLine: 'Instant',
  manaCost: '{R}',
  cmc: 1,
  colors: ['R'],
  colorIdentity: ['R'],
  oracleText: 'Lab Flash Bolt deals 1 damage to any target.\nFlashback {1}{R}',
});

function keeperOfSecretsScenario(gameId: GameId): CardTestScenario {
  const keeper = pinnedFrom(COVERAGE_PR03, 'Keeper of Secrets');
  return pr01Scenario(gameId, {
    id: 'keeper-of-secrets-viewer-flashback',
    title: 'Keeper of Secrets: flash back a spell to ping P2',
    instructions: [
      'Keeper of Secrets and two Mountains are on your battlefield; Lab Flash Bolt is in your graveyard.',
      'Cast Lab Flash Bolt from your graveyard for its flashback cost, targeting P3.',
      "Aim Keeper of Secrets' trigger at P2.",
    ],
    expectedOutcome:
      'Keeper of Secrets deals 1 damage (the spell’s mana value) to P2, then Lab Flash Bolt deals 1 damage to P3 and is exiled.',
    oracleSha256: keeper.sha256,
    clauseIds: ['keeper-of-secrets-keywords', 'keeper-of-secrets-symphony-of-pain'],
    decks: {
      P1: [keeper.card, LAB_FLASH_BOLT, MOUNTAIN, MOUNTAIN],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Keeper of Secrets', 'Mountain', 'Mountain'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Flash Bolt'] }],
    },
  });
}

function riverKelpieScenario(gameId: GameId): CardTestScenario {
  const kelpie = pinnedFrom(MARCHESA_BATCH1, 'River Kelpie');
  return pr01Scenario(gameId, {
    id: 'river-kelpie-viewer-flashback-and-persist',
    title: 'River Kelpie: draw from a flashback and from persist',
    instructions: [
      'River Kelpie, two Mountains and two Swamps are on your battlefield; Lab Flash Bolt is in your graveyard and Lab Doom is in your hand.',
      'Cast Lab Flash Bolt from your graveyard (flashback), targeting P2: a spell cast from a graveyard draws a card.',
      'Cast Lab Doom on River Kelpie: persist returns it from your graveyard, and it draws a card again.',
    ],
    expectedOutcome:
      'You draw Lab Ox and Lab Zombie, P2 takes 1 damage, and River Kelpie is back with a -1/-1 counter.',
    oracleSha256: kelpie.sha256,
    clauseIds: [
      'river-kelpie-enters-from-graveyard',
      'river-kelpie-cast-from-graveyard',
      'river-kelpie-persist',
    ],
    decks: {
      P1: [
        kelpie.card,
        LAB_FLASH_BOLT,
        LAB_DOOM,
        MOUNTAIN,
        MOUNTAIN,
        SWAMP,
        SWAMP,
        LAB_OX,
        LAB_ZOMBIE,
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Doom'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['River Kelpie', 'Mountain', 'Mountain', 'Swamp', 'Swamp'] },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Flash Bolt'] }],
    },
  });
}

function auroraPhoenixScenario(gameId: GameId): CardTestScenario {
  const phoenix = pinnedFrom(COVERAGE_PR03, 'Aurora Phoenix');
  const cascader = card({
    oracleId: 'lab-phoenix-cascader',
    name: 'Lab Cascader',
    typeLine: 'Creature — Elemental',
    manaCost: '{2}{R}',
    cmc: 3,
    colors: ['R'],
    colorIdentity: ['R'],
    power: '2',
    toughness: '2',
    oracleText: 'Cascade',
  });
  return pr01Scenario(gameId, {
    id: 'aurora-phoenix-viewer-cascade-return',
    title: 'Aurora Phoenix: cast a cascade spell to return it',
    instructions: [
      'Aurora Phoenix is in your graveyard; Lab Cascader (cascade) is in your hand with three Mountains.',
      'Cast Lab Cascader: the Phoenix returns from your graveyard to your hand.',
    ],
    expectedOutcome:
      'Aurora Phoenix returns to your hand; cascade exiles your two lands, finds nothing, and puts them on the bottom.',
    oracleSha256: phoenix.sha256,
    clauseIds: ['aurora-phoenix-flying', 'aurora-phoenix-cascade', 'aurora-phoenix-return'],
    decks: {
      P1: [phoenix.card, cascader, MOUNTAIN, MOUNTAIN, MOUNTAIN, FOREST, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Cascader'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Mountain', 'Mountain', 'Mountain'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Aurora Phoenix'] }],
    },
  });
}

function watcherForTomorrowScenario(gameId: GameId): CardTestScenario {
  const watcher = pinnedFrom(MARCHESA_BATCH1, 'Watcher for Tomorrow');
  return pr01Scenario(gameId, {
    id: 'watcher-for-tomorrow-viewer-hideaway-leaves',
    title: 'Watcher for Tomorrow: hide a card, then get it back as it leaves',
    instructions: [
      'Cast Watcher for Tomorrow with two Islands: it enters tapped; hide one of the top four cards.',
      'Cast Lab Doom on Watcher for Tomorrow with two Swamps.',
    ],
    expectedOutcome:
      'Watcher for Tomorrow dies and its leaves-the-battlefield trigger puts the hidden card into your hand.',
    oracleSha256: watcher.sha256,
    clauseIds: [
      'watcher-for-tomorrow-hideaway',
      'watcher-for-tomorrow-enters-tapped',
      'watcher-for-tomorrow-leaves',
    ],
    decks: {
      P1: [
        watcher.card,
        LAB_DOOM,
        ISLAND,
        ISLAND,
        SWAMP,
        SWAMP,
        LAB_OX,
        LAB_ZOMBIE,
        LAB_SERVO,
        LAB_BIRD,
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Watcher for Tomorrow', 'Lab Doom'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Island', 'Island', 'Swamp', 'Swamp'] }],
    },
  });
}

function psychomancerScenario(gameId: GameId): CardTestScenario {
  const psycho = pinnedFrom(MARCHESA_BATCH1, 'Psychomancer');
  const shatter = card({
    oracleId: 'lab-psycho-shatter',
    name: 'Lab Shatter',
    typeLine: 'Instant',
    manaCost: '{1}{R}',
    cmc: 2,
    colors: ['R'],
    colorIdentity: ['R'],
    oracleText: 'Destroy target artifact.',
  });
  return pr01Scenario(gameId, {
    id: 'psychomancer-viewer-artifact-drain',
    title: 'Psychomancer: drain P2 when your artifact is destroyed',
    instructions: [
      'Psychomancer, Lab Anrakyr Relic and two Mountains are on your battlefield; Lab Shatter is in your hand.',
      'Cast Lab Shatter on your own Lab Anrakyr Relic, then aim Psychomancer’s trigger at P2.',
    ],
    expectedOutcome: 'Lab Anrakyr Relic is destroyed; P2 loses 1 life and you gain 1 life.',
    oracleSha256: psycho.sha256,
    clauseIds: ['psychomancer-flying', 'psychomancer-harbinger-of-despair'],
    decks: {
      P1: [psycho.card, LAB_ANRAKYR_RELIC, shatter, MOUNTAIN, MOUNTAIN],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Shatter'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Psychomancer', 'Lab Anrakyr Relic', 'Mountain', 'Mountain'],
        },
      ],
    },
  });
}

function shardOfTheVoidDragonScenario(gameId: GameId): CardTestScenario {
  const shard = pinnedFrom(MARCHESA_BATCH1, 'Shard of the Void Dragon');
  return pr01Scenario(gameId, {
    id: 'shard-of-the-void-dragon-viewer-attack-edict',
    title: 'Shard of the Void Dragon: attack, and grow from the sacrificed artifact',
    instructions: [
      'Shard of the Void Dragon is on your battlefield; P2 controls Lab Anrakyr Relic and a Forest.',
      'Attack P2 with Shard of the Void Dragon.',
    ],
    expectedOutcome:
      'Each opponent sacrifices a nonland permanent: P2 loses Lab Anrakyr Relic, so Matter Absorption puts two +1/+1 counters on the Shard, which deals 9 combat damage to P2.',
    oracleSha256: shard.sha256,
    clauseIds: [
      'shard-of-the-void-dragon-flying',
      'shard-of-the-void-dragon-spear',
      'shard-of-the-void-dragon-matter-absorption',
    ],
    decks: {
      P1: [shard.card, SWAMP],
      P2: [LAB_ANRAKYR_RELIC, FOREST, FOREST],
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [
        { playerId: 'P1', cardNames: ['Shard of the Void Dragon'] },
        { playerId: 'P2', cardNames: ['Lab Anrakyr Relic', 'Forest'] },
      ],
      continueThroughCombat: true,
    },
  });
}

function scavengingOozeScenario(gameId: GameId): CardTestScenario {
  const ooze = pinnedFrom(MARCHESA_BATCH1, 'Scavenging Ooze');
  return pr01Scenario(gameId, {
    id: 'scavenging-ooze-viewer-exile-creature',
    title: 'Scavenging Ooze: exile a creature card to grow and gain life',
    instructions: [
      'Scavenging Ooze and a Forest are on your battlefield; Lab Ox is in your graveyard.',
      'Activate the Ooze for {G}, targeting Lab Ox in your graveyard.',
    ],
    expectedOutcome: 'Lab Ox is exiled; the Ooze gets a +1/+1 counter and you gain 1 life.',
    oracleSha256: ooze.sha256,
    clauseIds: ['scavenging-ooze-exile'],
    decks: {
      P1: [ooze.card, LAB_OX, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [],
      battlefield: [{ playerId: 'P1', cardNames: ['Scavenging Ooze', 'Forest'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Ox'] }],
    },
  });
}

function imotekhScenario(gameId: GameId): CardTestScenario {
  const imotekh = pinnedFrom(MARCHESA_BATCH1, 'Imotekh the Stormlord');
  const construct = card({
    oracleId: 'lab-imotekh-construct',
    name: 'Lab Construct',
    typeLine: 'Artifact Creature — Construct',
    manaCost: '{3}',
    cmc: 3,
    power: '1',
    toughness: '1',
  });
  const reanimate = card({
    oracleId: 'lab-imotekh-reanimate',
    name: 'Lab Reanimate',
    typeLine: 'Sorcery',
    manaCost: '{1}{B}',
    cmc: 2,
    colors: ['B'],
    colorIdentity: ['B'],
    oracleText: 'Return target creature card from your graveyard to the battlefield.',
  });
  return pr01Scenario(gameId, {
    id: 'imotekh-viewer-phaeron-and-strategist',
    title: 'Imotekh the Stormlord: reanimate an artifact, then buff it at combat',
    instructions: [
      'Imotekh and two Swamps are on your battlefield; Lab Construct is in your graveyard and Lab Reanimate in your hand.',
      'Cast Lab Reanimate on Lab Construct: an artifact card left your graveyard, so make two Necron Warriors.',
      'At the beginning of combat, give Lab Construct +2/+2 and menace.',
    ],
    expectedOutcome:
      'Lab Construct returns, two 2/2 Necron Warrior tokens are created, and Lab Construct is 3/3 with menace this turn.',
    oracleSha256: imotekh.sha256,
    clauseIds: ['imotekh-phaeron', 'imotekh-grand-strategist'],
    decks: {
      P1: [imotekh.card, construct, reanimate, SWAMP, SWAMP],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Reanimate'] }],
      battlefield: [{ playerId: 'P1', cardNames: ['Imotekh the Stormlord', 'Swamp', 'Swamp'] }],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Construct'] }],
      continueThroughCombat: true,
    },
  });
}

function theOozeScenario(gameId: GameId): CardTestScenario {
  const ooze = pinnedFrom(MARCHESA_BATCH1, 'The Ooze');
  const mutant = card({
    oracleId: 'lab-the-ooze-mutant',
    name: 'Lab Mutant',
    typeLine: 'Creature — Mutant',
    manaCost: '{1}{G}',
    cmc: 2,
    colors: ['G'],
    colorIdentity: ['G'],
    power: '2',
    toughness: '2',
  });
  const banish = card({
    oracleId: 'lab-the-ooze-banish',
    name: 'Lab Banish',
    typeLine: 'Sorcery',
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    colorIdentity: ['G'],
    oracleText: 'Exile target creature.',
  });
  return pr01Scenario(gameId, {
    id: 'the-ooze-viewer-leave-and-exile',
    title: 'The Ooze: Mutagens from a leaving creature and a graveyard exile',
    instructions: [
      'The Ooze, a Forest, and Lab Mutant with two +1/+1 counters are on your battlefield; Lab Banish is in your hand and Lab Ox is in your graveyard.',
      'Cast Lab Banish on Lab Mutant: it leaves the battlefield with two +1/+1 counters, so create two Mutagen tokens.',
      'Tap The Ooze to exile Lab Ox from your graveyard and create a third Mutagen.',
    ],
    expectedOutcome:
      'Lab Mutant and Lab Ox are exiled, The Ooze is tapped, and you control three Mutagen tokens.',
    oracleSha256: ooze.sha256,
    clauseIds: ['the-ooze-leave-trigger', 'the-ooze-exile'],
    decks: {
      P1: [ooze.card, mutant, banish, LAB_OX, FOREST],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['Lab Banish'] }],
      battlefield: [
        { playerId: 'P1', cardNames: ['The Ooze', 'Forest'] },
        { playerId: 'P1', cardNames: ['Lab Mutant'], counters: { '+1/+1': 2 } },
      ],
      graveyard: [{ playerId: 'P1', cardNames: ['Lab Ox'] }],
    },
  });
}

function godEternalRhonasScenario(gameId: GameId): CardTestScenario {
  const rhonas = pinnedFrom(COVERAGE_PR03, 'God-Eternal Rhonas');
  const banish = card({
    oracleId: 'lab-rhonas-banish',
    name: 'Lab Banish',
    typeLine: 'Sorcery',
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    colorIdentity: ['G'],
    oracleText: 'Exile target creature.',
  });
  return pr01Scenario(gameId, {
    id: 'god-eternal-rhonas-viewer-double-and-return',
    title: 'God-Eternal Rhonas: double your creatures, then go third from the top',
    instructions: [
      'Lab Ox (4/4) and six Forests are on your battlefield; God-Eternal Rhonas and Lab Banish are in your hand, and your library holds three cards.',
      'Cast God-Eternal Rhonas: Lab Ox has its power doubled and gains vigilance until end of turn.',
      'Cast Lab Banish on God-Eternal Rhonas, then choose to put it into your library third from the top.',
    ],
    expectedOutcome:
      'Lab Ox is 8/4 with vigilance, and God-Eternal Rhonas is the third card of your library.',
    oracleSha256: rhonas.sha256,
    clauseIds: [
      'god-eternal-rhonas-deathtouch',
      'god-eternal-rhonas-enters',
      'god-eternal-rhonas-leaves',
    ],
    decks: {
      P1: [
        rhonas.card,
        banish,
        LAB_OX,
        LAB_OX,
        LAB_OX,
        LAB_OX,
        ...Array.from({ length: 6 }, () => FOREST),
      ],
      P2: PR01_FILLER,
      P3: PR01_FILLER,
      P4: PR01_FILLER,
    },
    prepared: {
      hand: [{ playerId: 'P1', cardNames: ['God-Eternal Rhonas', 'Lab Banish'] }],
      battlefield: [
        {
          playerId: 'P1',
          cardNames: ['Lab Ox', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
        },
      ],
      libraryTop: [{ playerId: 'P1', cardNames: ['Lab Ox', 'Lab Ox', 'Lab Ox'] }],
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
  ...SPECIALIZED_REFERENCE_SCENARIO_IDS,
  ...ZONE_CHANGE_TRIGGER_SCENARIO_IDS,
  'mosswort-viewer-free-adventure-face',
  'mosswort-viewer-free-cast-stack',
  'mosswort-viewer-land-play-limit',
  ...BUG_HUNT_SCENARIO_IDS,
  ...TARGET_UNTAP_SCENARIO_IDS,
  ...SPELL_FACE_SCENARIO_IDS,
  ...COUNTER_OVERLOAD_SCENARIO_IDS,
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
  'canoptek-wraith-viewer-scout-same-name-search',
  'conjurers-closet-viewer-end-step-blink',
  'harvest-season-viewer-tapped-creature-count',
  'land-tax-viewer-upkeep-reveal-search',
  'mordant-dragon-viewer-combat-damage-redirect',
  'necron-deathmark-viewer-destroy-up-to-one-and-mill',
  'plasmancer-viewer-reveal-swamp',
  'sylvan-reclamation-viewer-exile-up-to-two',
  'sylvan-reclamation-viewer-basic-landcycling',
  'thunderfoot-baloth-viewer-lieutenant',
  'tomb-fortress-viewer-mill-then-return',
  'voice-of-many-viewer-draw-per-opponent',
  'foe-razer-regent-viewer-fight-and-grow',
  'hunting-wilds-viewer-kicked',
  'loran-of-the-third-path-viewer-destroy-up-to-one',
  'loran-of-the-third-path-viewer-tap-draw',
  'rishkar-viewer-counters-and-mana',
  'vastwood-surge-viewer-kicked',
  'frontier-siege-viewer-khans-mana',
  'frontier-siege-viewer-dragons-fight',
  'kairi-viewer-bounce-total-six',
  'kairi-viewer-mill-and-return',
  'will-of-the-mardu-viewer-choose-both',
  'aether-channeler-viewer-bounce-another',
  'aether-channeler-viewer-bird',
  'aether-channeler-viewer-draw',
  'return-to-nature-viewer-destroy-enchantment',
  'return-to-nature-viewer-exile-graveyard-card',
  'mystic-sanctuary-viewer-untapped-return',
  'brokers-hideout-viewer-sacrifice-and-search',
  'sweet-gum-recluse-viewer-new-creatures',
  'sweet-gum-recluse-viewer-flash-cascade',
  'sweet-gum-recluse-viewer-reach-block',
  'kogla-viewer-enters-fight',
  'kogla-viewer-bounce-and-attack',
  'opponent-graveyard-viewer-reanimate',
  'retrofitter-foundry-viewer-servo-thopter-construct',
  'aether-hub-viewer-energy-any-color',
  'aether-hub-viewer-colorless',
  'solar-transformer-viewer-cast-and-energy-mana',
  'solar-transformer-viewer-colorless',
  'bespoke-battlewagon-viewer-energy-and-crew',
  'bespoke-battlewagon-viewer-animate-and-draw',
  'bespoke-battlewagon-viewer-tap-target',
  'endless-atlas-viewer-same-name-draw',
  'endless-atlas-viewer-mixed-names-blocked',
  'sceptre-of-eternal-glory-viewer-three-black',
  'sceptre-of-eternal-glory-viewer-one-mana',
  'weathered-wayfarer-viewer-reveal-land',
  'weathered-wayfarer-viewer-equal-lands-blocked',
  'idol-of-oblivion-viewer-token-then-draw',
  'idol-of-oblivion-viewer-eldrazi',
  'mistveil-plains-viewer-bottom-of-library',
  'mistveil-plains-viewer-one-white-blocked',
  'carrion-feeder-viewer-sacrifice',
  'carrion-feeder-viewer-cant-block',
  'nullmage-shepherd-viewer-tap-four',
  'sage-of-fables-viewer-wizard-counter-draw',
  'illuminor-szeras-viewer-sacrifice-for-black',
  'peema-trailblazer-viewer-exhaust',
  'peema-trailblazer-viewer-combat-energy',
  'soul-guide-lantern-viewer-enters-exile',
  'soul-guide-lantern-viewer-exile-graveyards',
  'soul-guide-lantern-viewer-draw',
  'ghost-ark-viewer-crew-and-unearth',
  'flare-of-denial-viewer-sacrifice-counter',
  'flare-of-malice-viewer-sacrifice-edict',
  'blasphemous-edict-viewer-pay-b',
  'dread-return-viewer-flashback',
  'raffines-guidance-viewer-graveyard-recast',
  'their-number-is-legion-viewer-graveyard-x',
  'anrakyr-the-traveller-viewer-cast-for-life',
  'toxic-deluge-viewer-pay-two-life',
  'conclave-tribunal-viewer-convoke',
  'hour-of-reckoning-viewer-convoke',
  'killian-ink-duelist-viewer-reduced-bolt',
  'dragonkin-berserker-viewer-reduced-boast',
  'convergence-of-dominion-viewer-cheap-unearth',
  'kogla-and-yidaro-viewer-enter-fight',
  'kogla-and-yidaro-viewer-discard',
  'changing-loyalty-viewer-replicate',
  'changing-loyalty-viewer-steal',
  'grim-haruspex-viewer-morph',
  'dream-devourer-viewer-foretell',
  'dream-devourer-viewer-foretold-cast',
  'triarch-praetorian-viewer-unearth',
  'canoptek-tomb-sentinel-viewer-unearth-exile',
  'glen-elendra-archmage-viewer-counter-persist',
  'flayer-of-the-hatebound-viewer-undying-damage',
  'kambal-viewer-opponent-noncreature-spell',
  'gleeful-arsonist-viewer-burn-and-undying',
  'shard-of-the-nightbringer-viewer-cast-drain',
  'satoru-viewer-free-cast-draws',
  'keeper-of-secrets-viewer-flashback',
  'river-kelpie-viewer-flashback-and-persist',
  'aurora-phoenix-viewer-cascade-return',
  'watcher-for-tomorrow-viewer-hideaway-leaves',
  'psychomancer-viewer-artifact-drain',
  'shard-of-the-void-dragon-viewer-attack-edict',
  'scavenging-ooze-viewer-exile-creature',
  'imotekh-viewer-phaeron-and-strategist',
  'the-ooze-viewer-leave-and-exile',
  'god-eternal-rhonas-viewer-double-and-return',
] as const;

const SCENARIO_BUILDERS: Record<string, (gameId: GameId) => CardTestScenario> = {
  ...Object.fromEntries(
    SPECIALIZED_REFERENCE_SCENARIO_IDS.map((id) => [
      id,
      (gameId: GameId) => specializedReferenceScenario(id, gameId),
    ]),
  ),
  ...Object.fromEntries(
    ZONE_CHANGE_TRIGGER_SCENARIO_IDS.map((id) => [
      id,
      (gameId: GameId) => zoneChangeTriggerScenario(id, gameId),
    ]),
  ),
  ...Object.fromEntries(
    SPELL_FACE_SCENARIO_IDS.map((id) => [id, (gameId: GameId) => spellFaceScenario(id, gameId)]),
  ),
  ...Object.fromEntries(
    COUNTER_OVERLOAD_SCENARIO_IDS.map((id) => [
      id,
      (gameId: GameId) => counterOverloadScenario(id, gameId),
    ]),
  ),
  ...Object.fromEntries(
    TARGET_UNTAP_SCENARIO_IDS.map((id) => [
      id,
      (gameId: GameId) => targetUntapScenario(id, gameId),
    ]),
  ),
  ...Object.fromEntries(
    BUG_HUNT_SCENARIO_IDS.map((id) => [id, (gameId: GameId) => bugHuntScenario(id, gameId)]),
  ),
  'tribute-viewer-cast-search-select-resolve': tributeMageScenario,
  'gev-viewer-opponent-targets-ward': gevWardScenario,
  'nightscape-viewer-activate-regenerate-destroy': nightscapeScenario,
  'thran-viewer-graveyard-departure-trigger': thranVigilScenario,
  'harmonic-viewer-cast-and-double-trigger': harmonicProdigyScenario,
  'mosswort-viewer-free-adventure-face': (gameId) => mosswortCastingScenario(gameId, false, true),
  'mosswort-viewer-free-cast-stack': (gameId) => mosswortCastingScenario(gameId),
  'mosswort-viewer-land-play-limit': (gameId) => mosswortCastingScenario(gameId, true),
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
  'canoptek-wraith-viewer-scout-same-name-search': canoptekWraithScenario,
  'conjurers-closet-viewer-end-step-blink': conjurersClosetScenario,
  'harvest-season-viewer-tapped-creature-count': harvestSeasonScenario,
  'land-tax-viewer-upkeep-reveal-search': landTaxScenario,
  'mordant-dragon-viewer-combat-damage-redirect': mordantDragonScenario,
  'necron-deathmark-viewer-destroy-up-to-one-and-mill': necronDeathmarkScenario,
  'plasmancer-viewer-reveal-swamp': plasmancerScenario,
  'sylvan-reclamation-viewer-exile-up-to-two': sylvanReclamationScenario,
  'sylvan-reclamation-viewer-basic-landcycling': sylvanReclamationLandcyclingScenario,
  'thunderfoot-baloth-viewer-lieutenant': thunderfootBalothScenario,
  'tomb-fortress-viewer-mill-then-return': tombFortressScenario,
  'voice-of-many-viewer-draw-per-opponent': voiceOfManyScenario,
  'foe-razer-regent-viewer-fight-and-grow': foeRazerRegentScenario,
  'hunting-wilds-viewer-kicked': huntingWildsScenario,
  'loran-of-the-third-path-viewer-destroy-up-to-one': loranDestroyScenario,
  'loran-of-the-third-path-viewer-tap-draw': loranDrawScenario,
  'rishkar-viewer-counters-and-mana': rishkarScenario,
  'vastwood-surge-viewer-kicked': vastwoodSurgeScenario,
  'frontier-siege-viewer-khans-mana': frontierSiegeKhansScenario,
  'frontier-siege-viewer-dragons-fight': frontierSiegeDragonsScenario,
  'kairi-viewer-bounce-total-six': kairiScenario,
  'kairi-viewer-mill-and-return': kairiMillScenario,
  'will-of-the-mardu-viewer-choose-both': willOfTheMarduScenario,
  'aether-channeler-viewer-bounce-another': aetherChannelerScenario,
  'aether-channeler-viewer-bird': aetherChannelerBirdScenario,
  'aether-channeler-viewer-draw': aetherChannelerDrawScenario,
  'return-to-nature-viewer-destroy-enchantment': returnToNatureDestroyScenario,
  'return-to-nature-viewer-exile-graveyard-card': returnToNatureExileScenario,
  'mystic-sanctuary-viewer-untapped-return': mysticSanctuaryScenario,
  'brokers-hideout-viewer-sacrifice-and-search': brokersHideoutScenario,
  'sweet-gum-recluse-viewer-new-creatures': sweetGumRecluseScenario,
  'sweet-gum-recluse-viewer-flash-cascade': sweetGumRecluseFlashCascadeScenario,
  'sweet-gum-recluse-viewer-reach-block': sweetGumRecluseReachScenario,
  'kogla-viewer-enters-fight': koglaFightScenario,
  'kogla-viewer-bounce-and-attack': koglaAttackScenario,
  'opponent-graveyard-viewer-reanimate': opponentGraveyardScenario,
  'retrofitter-foundry-viewer-servo-thopter-construct': retrofitterFoundryScenario,
  'aether-hub-viewer-energy-any-color': aetherHubEnergyScenario,
  'aether-hub-viewer-colorless': aetherHubColorlessScenario,
  'solar-transformer-viewer-cast-and-energy-mana': solarTransformerEnergyScenario,
  'solar-transformer-viewer-colorless': solarTransformerColorlessScenario,
  'bespoke-battlewagon-viewer-energy-and-crew': battlewagonGainAndCrewScenario,
  'bespoke-battlewagon-viewer-animate-and-draw': battlewagonAnimateAndDrawScenario,
  'bespoke-battlewagon-viewer-tap-target': battlewagonTapTargetScenario,
  'endless-atlas-viewer-same-name-draw': endlessAtlasScenario,
  'endless-atlas-viewer-mixed-names-blocked': endlessAtlasBlockedScenario,
  'sceptre-of-eternal-glory-viewer-three-black': sceptreThreeScenario,
  'sceptre-of-eternal-glory-viewer-one-mana': sceptreOneScenario,
  'weathered-wayfarer-viewer-reveal-land': weatheredWayfarerSearchScenario,
  'weathered-wayfarer-viewer-equal-lands-blocked': weatheredWayfarerBlockedScenario,
  'idol-of-oblivion-viewer-token-then-draw': idolDrawScenario,
  'idol-of-oblivion-viewer-eldrazi': idolEldraziScenario,
  'mistveil-plains-viewer-bottom-of-library': mistveilBottomScenario,
  'mistveil-plains-viewer-one-white-blocked': mistveilBlockedScenario,
  'carrion-feeder-viewer-sacrifice': carrionFeederSacrificeScenario,
  'carrion-feeder-viewer-cant-block': carrionFeederCantBlockScenario,
  'nullmage-shepherd-viewer-tap-four': nullmageShepherdScenario,
  'sage-of-fables-viewer-wizard-counter-draw': sageOfFablesScenario,
  'illuminor-szeras-viewer-sacrifice-for-black': illuminorSzerasScenario,
  'peema-trailblazer-viewer-exhaust': peemaExhaustScenario,
  'peema-trailblazer-viewer-combat-energy': peemaCombatEnergyScenario,
  'soul-guide-lantern-viewer-enters-exile': soulGuideLanternEntersScenario,
  'soul-guide-lantern-viewer-exile-graveyards': soulGuideLanternExileScenario,
  'soul-guide-lantern-viewer-draw': soulGuideLanternDrawScenario,
  'ghost-ark-viewer-crew-and-unearth': ghostArkScenario,
  'flare-of-denial-viewer-sacrifice-counter': flareOfDenialScenario,
  'flare-of-malice-viewer-sacrifice-edict': flareOfMaliceScenario,
  'blasphemous-edict-viewer-pay-b': blasphemousEdictScenario,
  'dread-return-viewer-flashback': dreadReturnScenario,
  'raffines-guidance-viewer-graveyard-recast': raffinesGuidanceScenario,
  'their-number-is-legion-viewer-graveyard-x': theirNumberIsLegionScenario,
  'anrakyr-the-traveller-viewer-cast-for-life': anrakyrScenario,
  'toxic-deluge-viewer-pay-two-life': toxicDelugeScenario,
  'conclave-tribunal-viewer-convoke': conclaveTribunalScenario,
  'hour-of-reckoning-viewer-convoke': hourOfReckoningScenario,
  'killian-ink-duelist-viewer-reduced-bolt': killianScenario,
  'dragonkin-berserker-viewer-reduced-boast': dragonkinBerserkerScenario,
  'convergence-of-dominion-viewer-cheap-unearth': convergenceOfDominionScenario,
  'kogla-and-yidaro-viewer-enter-fight': koglaYidaroFightScenario,
  'kogla-and-yidaro-viewer-discard': koglaYidaroDiscardScenario,
  'changing-loyalty-viewer-replicate': changingLoyaltyReplicateScenario,
  'changing-loyalty-viewer-steal': changingLoyaltyStealScenario,
  'grim-haruspex-viewer-morph': grimHaruspexScenario,
  'dream-devourer-viewer-foretell': dreamDevourerForetellScenario,
  'dream-devourer-viewer-foretold-cast': dreamDevourerForetoldCastScenario,
  'triarch-praetorian-viewer-unearth': triarchPraetorianScenario,
  'canoptek-tomb-sentinel-viewer-unearth-exile': canoptekTombSentinelScenario,
  'glen-elendra-archmage-viewer-counter-persist': glenElendraArchmageScenario,
  'flayer-of-the-hatebound-viewer-undying-damage': flayerOfTheHateboundScenario,
  'kambal-viewer-opponent-noncreature-spell': kambalScenario,
  'gleeful-arsonist-viewer-burn-and-undying': gleefulArsonistScenario,
  'shard-of-the-nightbringer-viewer-cast-drain': shardOfTheNightbringerScenario,
  'satoru-viewer-free-cast-draws': satoruScenario,
  'keeper-of-secrets-viewer-flashback': keeperOfSecretsScenario,
  'river-kelpie-viewer-flashback-and-persist': riverKelpieScenario,
  'aurora-phoenix-viewer-cascade-return': auroraPhoenixScenario,
  'watcher-for-tomorrow-viewer-hideaway-leaves': watcherForTomorrowScenario,
  'psychomancer-viewer-artifact-drain': psychomancerScenario,
  'shard-of-the-void-dragon-viewer-attack-edict': shardOfTheVoidDragonScenario,
  'scavenging-ooze-viewer-exile-creature': scavengingOozeScenario,
  'imotekh-viewer-phaeron-and-strategist': imotekhScenario,
  'the-ooze-viewer-leave-and-exile': theOozeScenario,
  'god-eternal-rhonas-viewer-double-and-return': godEternalRhonasScenario,
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
