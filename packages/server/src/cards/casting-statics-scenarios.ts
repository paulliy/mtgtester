import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';
import { supportCard } from './pr09-scenario-fixtures';

type Pin = { sha256: string; card: OracleCard };

const pins = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/engine/tests/fixtures/casting-statics-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;

/** The pin file hashes each card's JSON with its keys sorted at every level. */
export function canonicalSha256(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}

for (const entry of pins)
  if (canonicalSha256(entry.card) !== entry.sha256)
    throw new Error(`Casting-statics Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing casting-statics Oracle pin ${name}`);
  return found;
}
const card = (name: string): OracleCard => pin(name).card;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'];
const KEYWORD_TEXT = new Set(['Flying', 'Lifelink', 'Infect']);

/** A source-free Card Test Lab support card; the Oracle text is interpreted by the real engine. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
): OracleCard {
  const base = supportCard('Forest', 'casting-statics support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-casting-statics-${slug(name)}`;
  const generic = [...manaCost.matchAll(/\{([0-9]+)\}/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return {
    ...base,
    oracleId: id,
    scryfallId: id,
    name,
    manaCost: manaCost as OracleCard['manaCost'],
    cmc: generic + (manaCost.match(/\{[WUBRG](\/P)?\}/g)?.length ?? 0),
    colors,
    colorIdentity: colors,
    typeLine,
    types: words.filter((word) => CARD_TYPES.includes(word)) as OracleCard['types'],
    supertypes: words.includes('Legendary') ? ['Legendary'] : [],
    subtypes: right === undefined ? [] : right.split(' '),
    oracleText,
    power: stats?.[0] ?? null,
    toughness: stats?.[1] ?? null,
    keywords: KEYWORD_TEXT.has(oracleText) ? [oracleText] : [],
    isBasicLand: false,
  };
}

export const SHOCK = lab(
  'CS Lab Shock',
  'Instant',
  '{R}',
  'CS Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const BEAR = lab('CS Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const SALVE = lab('CS Lab Salve', 'Instant', '{W}', 'You gain 3 life.', ['W']);
/** Four {G/P} pips: 8 life with no green mana. */
export const MENDING = lab('CS Lab Mending', 'Instant', '{G/P}{G/P}{G/P}{G/P}', 'Draw a card.', [
  'G',
]);
/**
 * Always in P1's hand: a free spell P1 can cast at any time it has priority, so the viewer is
 * still given priority after the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('CS Lab Trinket', 'Artifact', '{0}', '', []);

/** A permanent arranged on the battlefield, optionally with counters. */
interface Placed {
  card: OracleCard;
  counters?: Record<string, number>;
}
type FieldEntry = OracleCard | Placed;
const placed = (entry: FieldEntry): Placed => ('card' in entry ? entry : { card: entry });

/**
 * What a scripted opponent does: the first time it holds priority with an empty stack while the
 * action is available, and at each attack declaration it makes.
 */
export interface OpponentPlan {
  seat: PlayerId;
  /** Cast this spell. */
  cast?: OracleCard;
  /** Preferred choice per target slot: a seat id or a permanent name. */
  targets: string[];
  /** Which defending seat or planeswalker (by name) each named creature attacks. */
  attacks?: Record<string, string>;
  /** The option taken whenever it is offered a choice that is not a priority decision. */
  choose?: RegExp;
}

interface Def {
  id: string;
  cardName: string;
  title: string;
  /** 1-based Oracle lines this scenario exercises; `face-N` names a line of the spell face. */
  lines: (number | `face-${number}`)[];
  instructions: string[];
  expectedOutcome: string;
  p1Hand: OracleCard[];
  p1Field?: FieldEntry[];
  /** Basic lands P1 controls, by name. */
  p1Lands?: string[];
  /** Known cards on top of P1's library, first on top. */
  p1LibraryTop?: OracleCard[];
  p2Hand?: OracleCard[];
  p2Field?: FieldEntry[];
  p2Lands?: string[];
  opponent?: OpponentPlan;
  /** Further seats with their own scripted plans. */
  otherOpponents?: OpponentPlan[];
  lifeTotals?: Array<{ playerId: PlayerId; life: number }>;
  prepared?: Partial<PreparedScenarioSpec>;
}

const entry = (
  cardName: string,
  kind: string,
  title: string,
  lines: Def['lines'],
  instructions: string[],
  expectedOutcome: string,
  rest: Omit<Def, 'id' | 'cardName' | 'title' | 'lines' | 'instructions' | 'expectedOutcome'>,
): Def => ({
  id: `casting-statics-${slug(cardName)}-viewer-${kind}`,
  cardName,
  title,
  lines,
  instructions,
  expectedOutcome,
  ...rest,
});

const lands = (name: string, count: number) => Array.from({ length: count }, () => name);

const ORRERY = 'Vedalken Orrery';
const THALIA = 'Thalia, Guardian of Thraben';
const TORBRAN = 'Torbran, Thane of Red Fell';
const EMANCIPATION = 'Fiery Emancipation';
const KNIGHT = "Knight of Dawn's Light";
const RHOX = 'Rhox Faithmender';
const BOON = 'Boon Reflection';
const TALISMAN = 'Pristine Talisman';

const DEFS: Def[] = [
  entry(
    ORRERY,
    'flash-response',
    'Vedalken Orrery: cast a creature spell in response to an opponent’s spell',
    [1],
    [
      'Pass priority with an empty stack. P2 casts CS Lab Shock targeting you.',
      'With CS Lab Shock on the stack, cast CS Lab Bear.',
    ],
    'CS Lab Bear resolves before CS Lab Shock, which then deals 2 damage to you.',
    {
      p1Hand: [BEAR],
      p1Field: [card(ORRERY)],
      p1Lands: lands('Forest', 2),
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: { seat: 'P2', cast: SHOCK, targets: ['P1'] },
    },
  ),
  entry(
    THALIA,
    'noncreature-tax',
    'Thalia: an opponent’s noncreature spell costs {1} more',
    [2],
    ['Cast CS Lab Shock targeting P2, paying {1}{R}.'],
    'CS Lab Shock costs {1}{R}: both your Mountains tap, and P2 takes 2 damage.',
    {
      p1Hand: [SHOCK],
      p1Lands: lands('Mountain', 2),
      p2Field: [card(THALIA)],
    },
  ),
  entry(
    TORBRAN,
    'plus-two',
    'Torbran: your red spell deals 2 more damage to an opponent',
    [1],
    ['Cast CS Lab Shock targeting P2.'],
    'CS Lab Shock deals 4 damage to P2 instead of 2.',
    {
      p1Hand: [SHOCK],
      p1Field: [card(TORBRAN)],
      p1Lands: ['Mountain'],
    },
  ),
  entry(
    EMANCIPATION,
    'triple',
    'Fiery Emancipation: your spell deals triple damage',
    [1],
    ['Cast CS Lab Shock targeting P2.'],
    'CS Lab Shock deals 6 damage to P2 instead of 2.',
    {
      p1Hand: [SHOCK],
      p1Field: [card(EMANCIPATION)],
      p1Lands: ['Mountain'],
    },
  ),
  entry(
    KNIGHT,
    'plus-first',
    'Knight of Dawn’s Light and Rhox Faithmender: apply “plus 1” first',
    [2],
    ['Cast CS Lab Salve.', 'When asked which effect applies first, choose Knight of Dawn’s Light.'],
    'You gain (3 + 1) × 2 = 8 life.',
    {
      p1Hand: [SALVE],
      p1Field: [card(KNIGHT), card(RHOX)],
      p1Lands: ['Plains'],
    },
  ),
  entry(
    RHOX,
    'twice-first',
    'Rhox Faithmender and Knight of Dawn’s Light: apply “twice” first',
    [2],
    ['Cast CS Lab Salve.', 'When asked which effect applies first, choose Rhox Faithmender.'],
    'You gain 3 × 2 + 1 = 7 life.',
    {
      p1Hand: [SALVE],
      p1Field: [card(KNIGHT), card(RHOX)],
      p1Lands: ['Plains'],
    },
  ),
  entry(
    BOON,
    'payment-order',
    'Pristine Talisman’s replaced life gain pays for four Phyrexian pips',
    [1],
    [
      'At 1 life, cast CS Lab Mending, paying all four {G/P} with life.',
      'The payment taps Pristine Talisman and applies Knight of Dawn’s Light first.',
    ],
    'Pristine Talisman’s 1 life becomes (1 + 1) × 2 × 2 = 8, so you go to 9 life and pay 8.',
    {
      p1Hand: [MENDING],
      p1Field: [card(TALISMAN), card(KNIGHT), card(RHOX), card(BOON)],
      lifeTotals: [{ playerId: 'P1', life: 1 }],
    },
  ),
];

export const CASTING_STATICS_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({
  id,
  cardName,
  title,
}));

/** The scripted opponent: takes its planned action once, declares its planned attacks, then passes. */
function opponentProvider(plan: OpponentPlan, engine: () => Engine) {
  let done = false;
  const named = (want: string, options: readonly string[]) => {
    if (options.includes(want)) return want;
    return engine()
      .getState()
      .battlefield.find((perm) => perm.name === want && options.includes(perm.id))?.id;
  };
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const attack = request.legalActions.find((action) => action.type === 'attackDeclaration');
      if (attack !== undefined) {
        const subjects = (attack.data?.['subjects'] ?? []) as { subjectId: string }[];
        const battlefield = engine().getState().battlefield;
        return {
          requestId: request.requestId,
          actionId: attack.id,
          targets: (attack.targets ?? []).map((slot) => {
            const attacker = battlefield.find((perm) => perm.id === subjects[slot.slot]?.subjectId);
            const want = attacker === undefined ? undefined : plan.attacks?.[attacker.name];
            return {
              slot: slot.slot,
              choice:
                (want === undefined ? undefined : named(want, slot.options)) ?? '__no_attack__',
            };
          }),
        };
      }
      const chosen =
        pass === undefined && plan.choose !== undefined
          ? request.legalActions.find((candidate) => plan.choose!.test(candidate.description))
          : undefined;
      if (chosen !== undefined) return { requestId: request.requestId, actionId: chosen.id };
      // It acts only with an empty stack: never in response to the viewer's spell.
      const action =
        done || plan.cast === undefined || engine().getState().stack.length > 0
          ? undefined
          : request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' && candidate.description.includes(plan.cast!.name),
            );
      if (action === undefined)
        return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
      done = true;
      return {
        requestId: request.requestId,
        actionId: action.id,
        targets: (action.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice:
            named(plan.targets[slot.slot] ?? '', slot.options) ??
            slot.options.find((option) => option !== plan.seat) ??
            slot.options[0]!,
        })),
      };
    },
  };
}

function battlefieldGroups(playerId: PlayerId, entries: FieldEntry[], basics: string[]) {
  const plain = [...basics];
  const groups: PreparedScenarioSpec['battlefield'] = [];
  for (const item of entries.map(placed)) {
    if (item.counters === undefined) plain.push(item.card.name);
    else groups.push({ playerId, cardNames: [item.card.name], counters: item.counters });
  }
  return plain.length > 0 ? [{ playerId, cardNames: plain }, ...groups] : groups;
}

/** The clause ids a casting-statics card's Oracle text declares: front lines, then spell-face lines. */
export function castingStaticsClauseIds(oracle: OracleCard): string[] {
  const base = `casting-statics-${slug(oracle.name)}-clause-`;
  return [
    ...oracle.oracleText.split('\n').map((_, index) => `${base}${index + 1}`),
    ...(oracle.backFace?.oracleText.split('\n') ?? []).map(
      (_, index) => `${base}face-${index + 1}`,
    ),
  ];
}

/** Source-pinned prepared Card Test Lab scenarios for the casting statics and replacements (engine-feature batch 1). */
export function castingStaticsScenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown casting-statics scenario ${id}`);
  const source = pin(def.cardName);
  const p1Field = (def.p1Field ?? []).map(placed);
  const p2Field = (def.p2Field ?? []).map(placed);
  const p1Lands = def.p1Lands ?? [];
  const p2Lands = def.p2Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'casting-statics support land'));
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'casting-statics filler land'),
    );

  const p1Hand = [...def.p1Hand, TRINKET];
  const p1Cards = [
    ...p1Hand,
    ...p1Field.map((item) => item.card),
    ...named(p1Lands),
    ...(def.p1LibraryTop ?? []),
  ];
  const p2Cards = [...(def.p2Hand ?? []), ...p2Field.map((item) => item.card), ...named(p2Lands)];

  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `casting-statics-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [...p1Cards, ...filler(24)]
        : seat === 'P2'
          ? [...p2Cards, ...filler(24)]
          : filler(24),
  }));

  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
    hand: [
      { playerId: 'P1', cardNames: p1Hand.map((item) => item.name) },
      ...(def.p2Hand?.length
        ? [{ playerId: 'P2' as const, cardNames: def.p2Hand.map((item) => item.name) }]
        : []),
    ],
    battlefield: [
      ...battlefieldGroups('P1', def.p1Field ?? [], p1Lands),
      ...battlefieldGroups('P2', def.p2Field ?? [], p2Lands),
    ],
    ...(def.p1LibraryTop?.length
      ? { libraryTop: [{ playerId: 'P1', cardNames: def.p1LibraryTop.map((item) => item.name) }] }
      : {}),
    ...(def.lifeTotals ? { lifeTotals: def.lifeTotals } : {}),
    ...def.prepared,
  };

  const seed = `casting-statics-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  const base = `casting-statics-${slug(def.cardName)}-clause-`;
  return {
    metadata: {
      id,
      version: 1,
      title: def.title,
      instructions: def.instructions,
      expectedOutcome: def.expectedOutcome,
      oracleSha256: source.sha256,
      clauseIds: def.lines.map((line) => `${base}${line}`),
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
    ...(def.opponent
      ? {
          decisionProviderOverrides: Object.fromEntries(
            [def.opponent, ...(def.otherOpponents ?? [])].map((plan) => [
              plan.seat,
              opponentProvider(plan, () => engine),
            ]),
          ),
        }
      : {}),
  };
}
