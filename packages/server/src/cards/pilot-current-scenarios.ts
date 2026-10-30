import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';
import { supportCard } from './pr09-scenario-fixtures';

/**
 * Card Test Lab scenarios for the phase 6 pilot's current-workflow batch (`pilot-current`),
 * written by hand in the PR11b form: each scenario names its prepared position, and a scripted
 * opponent answers for the other seat. The pilot cards come from the Oracle pin store.
 */

interface PinStoreFile {
  names: Record<string, string>;
  cards: Record<string, OracleCard>;
}

const store = JSON.parse(
  readFileSync(
    new URL('../../../../packages/engine/tests/fixtures/pin-store.json', import.meta.url),
    'utf8',
  ),
) as PinStoreFile;

function pinned(name: string): { sha256: string; card: OracleCard } {
  const sha256 = store.names[name];
  if (sha256 === undefined) throw new Error(`Pilot card ${name} is not in the pin store`);
  return { sha256, card: store.cards[sha256]! };
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'];

/** A source-free support card; the real engine interprets its Oracle text. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
): OracleCard {
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pilot-${slug(name)}`;
  const generic = [...manaCost.matchAll(/\{([0-9]+)\}/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return {
    ...supportCard('Forest', 'Pilot support land'),
    oracleId: id,
    scryfallId: id,
    name,
    manaCost: manaCost as OracleCard['manaCost'],
    cmc: generic + (manaCost.match(/\{[WUBRG]\}/g)?.length ?? 0),
    colors,
    colorIdentity: colors,
    typeLine,
    types: words.filter((word) => CARD_TYPES.includes(word)) as OracleCard['types'],
    supertypes: words.includes('Legendary') ? ['Legendary'] : [],
    subtypes: right === undefined ? [] : right.split(' '),
    oracleText,
    power: stats?.[0] ?? null,
    toughness: stats?.[1] ?? null,
    loyalty: null,
    keywords: [],
    isBasicLand: false,
  };
}

export const BLACK_SORCERY = lab(
  'Pilot Lab Black Sorcery',
  'Sorcery',
  '{1}{B}',
  'You gain 2 life.',
  ['B'],
);
export const RED_SORCERY = lab('Pilot Lab Red Sorcery', 'Sorcery', '{1}{R}', 'You gain 2 life.', [
  'R',
]);
/**
 * Always in P1's hand: a free spell P1 can cast whenever it has priority, so the viewer is still
 * given priority when the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('Pilot Lab Trinket', 'Artifact', '{0}', '', []);

const SUPPORT_CARDS = [BLACK_SORCERY, RED_SORCERY, TRINKET];

/** A permanent in a starting position, with what differs from an untapped, counterless one. */
type FieldEntry = string | { card: string; tapped?: true; counters?: Record<string, number> };

export interface OpponentPlan {
  seat: PlayerId;
  /** Cast the hand card with this name once, with an empty stack. */
  cast?: string;
  /** Per target slot: a seat id or a permanent name. */
  targets?: string[];
  /** Options it picks in non-priority decisions, matched against the description. */
  answers?: RegExp[];
  /** Attack this seat with every creature it can. */
  attack?: PlayerId;
}

interface ScenarioDef {
  id: string;
  cardName: string;
  title: string;
  instructions: string[];
  expectedOutcome: string;
  /** The Oracle lines the scenario covers, counting from 1. */
  lines: number[];
  p1Hand?: string[];
  p1Field?: FieldEntry[];
  p1Graveyard?: string[];
  /** P1's library top, below the card it draws for the turn. */
  p1Top?: string[];
  p2Hand?: string[];
  p2Field?: FieldEntry[];
  opponent?: OpponentPlan;
  prepared?: Partial<PreparedScenarioSpec>;
}

const DEFS: ScenarioDef[] = [
  {
    id: 'pilot-current-jet-medallion-viewer-reduced',
    cardName: 'Jet Medallion',
    title: 'Jet Medallion: a {1}{B} sorcery cast with one Swamp',
    instructions: ['Cast Pilot Lab Black Sorcery, paying with your one Swamp.'],
    expectedOutcome: 'Pilot Lab Black Sorcery costs only {B}; it resolves and you gain 2 life.',
    lines: [1],
    p1Hand: ['Pilot Lab Black Sorcery'],
    p1Field: ['Jet Medallion', 'Swamp'],
  },
  {
    id: 'pilot-current-jet-medallion-viewer-not-red',
    cardName: 'Jet Medallion',
    title: 'Jet Medallion: a {1}{R} sorcery is not reduced',
    instructions: ['Try to cast Pilot Lab Red Sorcery with your one Mountain.'],
    expectedOutcome: 'Pilot Lab Red Sorcery still costs {1}{R} and cannot be cast.',
    lines: [1],
    p1Hand: ['Pilot Lab Red Sorcery'],
    p1Field: ['Jet Medallion', 'Mountain'],
  },
];

export const PILOT_CURRENT_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({
  id,
  cardName,
  title,
}));

/** The scripted opponent: its planned cast once, its attack, its answers; otherwise it passes. */
function opponentProvider(plan: OpponentPlan, engine: () => Engine) {
  let cast = false;
  const nameOf = (id: string) =>
    engine()
      .getState()
      .battlefield.find((perm) => perm.id === id)?.name;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const respond = (
        actionId: DecisionResponse['actionId'],
        targets?: NonNullable<DecisionResponse['targets']>,
      ): DecisionResponse =>
        targets === undefined
          ? { requestId: request.requestId, actionId }
          : { requestId: request.requestId, actionId, targets };
      const attack = request.legalActions.find((action) => action.type === 'attackDeclaration');
      if (attack !== undefined)
        return respond(
          attack.id,
          (attack.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice:
              plan.attack !== undefined && slot.options.includes(plan.attack)
                ? plan.attack
                : '__no_attack__',
          })),
        );
      const pass = request.legalActions.find((action) => action.type === 'pass');
      if (pass === undefined) {
        for (const pattern of plan.answers ?? []) {
          const found = request.legalActions.find((action) => pattern.test(action.description));
          if (found !== undefined) return respond(found.id);
        }
        return respond(request.legalActions[0]!.id);
      }
      const spell =
        cast || plan.cast === undefined || engine().getState().stack.length > 0
          ? undefined
          : request.legalActions.find(
              (action) =>
                action.type === 'castSpell' && action.description.startsWith(`Cast ${plan.cast}`),
            );
      if (spell === undefined) return respond(pass.id);
      cast = true;
      return respond(
        spell.id,
        (spell.targets ?? []).map((slot) => {
          const want = plan.targets?.[slot.slot] ?? '';
          return {
            slot: slot.slot,
            choice:
              slot.options.find((option) => option === want || nameOf(option) === want) ??
              slot.options[0]!,
          };
        }),
      );
    },
  };
}

function fieldGroups(
  playerId: PlayerId,
  entries: FieldEntry[],
): PreparedScenarioSpec['battlefield'] {
  const plain: string[] = [];
  const groups: PreparedScenarioSpec['battlefield'] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') plain.push(entry);
    else
      groups.push({
        playerId,
        cardNames: [entry.card],
        ...(entry.tapped === undefined ? {} : { tapped: true }),
        ...(entry.counters === undefined ? {} : { counters: entry.counters }),
      });
  }
  return plain.length > 0 ? [{ playerId, cardNames: plain }, ...groups] : groups;
}

/** A prepared Card Test Lab scenario for one of the pilot-current cards. */
export function pilotCurrentScenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (def === undefined) throw new Error(`Unknown pilot-current scenario ${id}`);
  const source = pinned(def.cardName);
  const known = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    known.set(basic, supportCard(basic, 'Pilot support land'));
  for (const support of SUPPORT_CARDS) known.set(support.name, support);
  const cardNamed = (name: string): OracleCard =>
    known.get(name) ??
    (store.names[name] !== undefined ? pinned(name).card : undefined) ??
    (() => {
      throw new Error(`${id}: no card named ${name}`);
    })();
  const names = (entries: FieldEntry[] = []) =>
    entries.map((entry) => (typeof entry === 'string' ? entry : entry.card));
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'Pilot filler land'),
    );
  const p1Hand = [...(def.p1Hand ?? []), TRINKET.name];
  const p1Cards = [
    ...p1Hand,
    ...names(def.p1Field),
    ...(def.p1Graveyard ?? []),
    ...(def.p1Top ?? []),
  ];
  const p2Cards = [...(def.p2Hand ?? []), ...names(def.p2Field)];
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pilot-current-${seat}`,
    commanders: [],
    cards: [
      ...(seat === 'P1' ? p1Cards : seat === 'P2' ? p2Cards : []).map(cardNamed),
      ...filler(24),
    ],
  }));
  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
    hand: [
      { playerId: 'P1', cardNames: p1Hand },
      ...(def.p2Hand?.length ? [{ playerId: 'P2' as const, cardNames: def.p2Hand }] : []),
    ],
    battlefield: [...fieldGroups('P1', def.p1Field ?? []), ...fieldGroups('P2', def.p2Field ?? [])],
    ...(def.p1Graveyard?.length
      ? { graveyard: [{ playerId: 'P1' as const, cardNames: def.p1Graveyard }] }
      : {}),
    // The first library card is the one P1 draws for the turn, so the named cards sit below it.
    ...(def.p1Top?.length
      ? { libraryTop: [{ playerId: 'P1' as const, cardNames: ['Forest', ...def.p1Top] }] }
      : {}),
    ...def.prepared,
  };
  const seed = `pilot-current-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  return {
    metadata: {
      id,
      version: 1,
      title: def.title,
      instructions: def.instructions,
      expectedOutcome: def.expectedOutcome,
      oracleSha256: source.sha256,
      clauseIds: def.lines.map((line) => `pilot-current-${slug(def.cardName)}-clause-${line}`),
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
    engine,
    ...(def.opponent === undefined
      ? {}
      : {
          decisionProviderOverrides: {
            [def.opponent.seat]: opponentProvider(def.opponent, () => engine),
          },
        }),
  };
}
