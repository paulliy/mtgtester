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
        '../../../../packages/engine/tests/fixtures/coverage-pr12-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;

for (const entry of pins)
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`PR12 Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR12 Oracle pin ${name}`);
  return found;
}
const card = (name: string): OracleCard => pin(name).card;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'];
const KEYWORD_TEXT = new Set(['Flying']);

/** A source-free Card Test Lab support card; the Oracle text is interpreted by the real engine. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
): OracleCard {
  const base = supportCard('Forest', 'PR12 support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pr12-${slug(name)}`;
  const generic = [...manaCost.matchAll(/\{([0-9]+)\}/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return {
    ...base,
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
    keywords: KEYWORD_TEXT.has(oracleText) ? [oracleText] : [],
    isBasicLand: false,
  };
}

export const SHOCK = lab(
  'PR12 Lab Shock',
  'Instant',
  '{R}',
  'PR12 Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const BEAR = lab('PR12 Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const DRAGON = lab(
  'PR12 Lab Dragon',
  'Creature — Dragon',
  '{3}{R}',
  'Flying',
  ['R'],
  ['4', '4'],
);
export const RELIC = lab('PR12 Lab Relic', 'Artifact', '{3}', '', []);
/**
 * Always in P1's hand: a free spell P1 can cast at any time it has priority, so the viewer is
 * still given priority after the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('PR12 Lab Trinket', 'Artifact', '{0}', '', []);

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
  id: `pr12-${slug(cardName)}-viewer-${kind}`,
  cardName,
  title,
  lines,
  instructions,
  expectedOutcome,
  ...rest,
});

const lands = (name: string, count: number) => Array.from({ length: count }, () => name);
const COMBAT: Partial<PreparedScenarioSpec> = { continueThroughCombat: true };
const SIVITRI = 'Sivitri, Dragon Master';
const sivitri = (loyalty: number): Placed => ({ card: card(SIVITRI), counters: { loyalty } });
const P2_BEAR_ATTACKS: OpponentPlan = {
  seat: 'P2',
  targets: [],
  attacks: { 'PR12 Lab Bear': 'P1' },
};

const BLACK_BOLT = 'Black Bolt, Inhuman King';
const ZURGO = 'Zurgo and Ojutai';
const BLOOMVINE = 'Bloomvine Regent // Claim Territory';
const MARANG = 'Marang River Regent // Coil and Catch';
const MANUAL = 'Monster Manual // Zoological Study';

const DEFS: Def[] = [
  // PR12.01 Black Bolt, Inhuman King
  entry(
    BLACK_BOLT,
    'lethal-voice',
    'Black Bolt: an opponent targets it, so destroy a permanent of theirs',
    [3],
    [
      'Pass priority. P2 casts PR12 Lab Shock targeting Black Bolt.',
      'For Lethal Voice, target P2’s PR12 Lab Relic.',
    ],
    'Lethal Voice destroys P2’s PR12 Lab Relic, and Black Bolt survives the 2 damage.',
    {
      p1Hand: [],
      p1Field: [card(BLACK_BOLT)],
      p2Hand: [SHOCK],
      p2Field: [RELIC],
      p2Lands: ['Mountain'],
      opponent: { seat: 'P2', cast: SHOCK, targets: [BLACK_BOLT] },
    },
  ),
  entry(
    BLACK_BOLT,
    'noncreature-pump',
    'Black Bolt: a noncreature spell gives it +2/+2, then it attacks',
    [1, 2],
    ['Cast PR12 Lab Relic.', 'Attack P2 with Black Bolt.'],
    'Black Bolt is 5/5 until end of turn, flies over, and deals 5 damage to P2.',
    {
      p1Hand: [RELIC],
      p1Field: [card(BLACK_BOLT)],
      p1Lands: lands('Plains', 3),
      prepared: COMBAT,
    },
  ),
  entry(
    BLACK_BOLT,
    'creature-spell',
    'Black Bolt: a creature spell does not pump it',
    [2],
    ['Cast PR12 Lab Bear.', 'Attack P2 with Black Bolt.'],
    'Black Bolt stays 3/3 and deals 3 damage to P2.',
    {
      p1Hand: [BEAR],
      p1Field: [card(BLACK_BOLT)],
      p1Lands: lands('Forest', 2),
      prepared: COMBAT,
    },
  ),

  // PR12.02 Dingus Staff
  entry(
    'Dingus Staff',
    'opponent-creature',
    'Dingus Staff: an opponent’s creature dies, so its controller takes 2',
    [1],
    ['Cast PR12 Lab Shock targeting P2’s PR12 Lab Bear.'],
    'The bear dies and Dingus Staff deals 2 damage to P2, its controller. You take none.',
    {
      p1Hand: [SHOCK],
      p1Field: [card('Dingus Staff')],
      p1Lands: ['Mountain'],
      p2Field: [BEAR],
    },
  ),
  entry(
    'Dingus Staff',
    'own-creature',
    'Dingus Staff: your own creature dies, so you take 2',
    [1],
    ['Cast PR12 Lab Shock targeting your PR12 Lab Bear.'],
    'Your bear dies and Dingus Staff deals 2 damage to you. P2 takes none.',
    {
      p1Hand: [SHOCK],
      p1Field: [card('Dingus Staff'), BEAR],
      p1Lands: ['Mountain'],
    },
  ),

  // PR12.03 Sivitri, Dragon Master
  entry(
    SIVITRI,
    'attack-tax',
    'Sivitri: +1, then P2 pays 2 life to attack you',
    [1],
    ['Activate Sivitri’s +1 ability.', 'Pass the turn. On P2’s turn, P2 attacks you with a bear.'],
    'P2 pays 2 life for its attacking bear and the bear deals 2 damage to you.',
    {
      p1Hand: [],
      p1Field: [sivitri(4)],
      p2Field: [BEAR],
      opponent: P2_BEAR_ATTACKS,
      prepared: { continueThroughNextCombat: true },
    },
  ),
  entry(
    SIVITRI,
    'unaffordable-tax',
    'Sivitri: a player at 1 life cannot pay to attack you',
    [1],
    ['Activate Sivitri’s +1 ability.', 'Pass the turn. On P2’s turn, P2 tries to attack you.'],
    'P2 cannot pay 2 life, so its bear does not attack and no one loses life.',
    {
      p1Hand: [],
      p1Field: [sivitri(4)],
      p2Field: [BEAR],
      opponent: P2_BEAR_ATTACKS,
      lifeTotals: [{ playerId: 'P2', life: 1 }],
      prepared: { continueThroughNextCombat: true },
    },
  ),
  entry(
    SIVITRI,
    'tutor',
    'Sivitri: −3 finds a Dragon card',
    [2],
    ['Activate Sivitri’s −3 ability.', 'Choose PR12 Lab Dragon.'],
    'PR12 Lab Dragon is revealed and put into your hand, your library is shuffled, and Sivitri has 1 loyalty.',
    {
      p1Hand: [],
      p1Field: [sivitri(4)],
      p1LibraryTop: [RELIC, DRAGON],
    },
  ),
  entry(
    SIVITRI,
    'wrath',
    'Sivitri: −7 destroys every non-Dragon creature',
    [3],
    ['Activate Sivitri’s −7 ability.'],
    'Both PR12 Lab Bears are destroyed and your PR12 Lab Dragon survives.',
    {
      p1Hand: [],
      p1Field: [sivitri(7), DRAGON, BEAR],
      p2Field: [BEAR],
    },
  ),

  // PR12.04 Zurgo and Ojutai
  entry(
    ZURGO,
    'return',
    'Zurgo and Ojutai: combat damage digs three and returns it',
    [1, 3],
    [
      'Attack P2 with Zurgo and Ojutai.',
      'Put PR12 Lab Relic into your hand and the rest on the bottom.',
      'Return Zurgo and Ojutai to your hand.',
    ],
    'P2 takes 4, PR12 Lab Relic goes to your hand, and Zurgo and Ojutai returns to your hand.',
    {
      p1Hand: [],
      p1Field: [card(ZURGO)],
      p1LibraryTop: [SHOCK, RELIC, BEAR],
      prepared: COMBAT,
    },
  ),
  entry(
    ZURGO,
    'keep',
    'Zurgo and Ojutai: keep the Dragon on the battlefield',
    [3],
    [
      'Attack P2 with Zurgo and Ojutai.',
      'Put PR12 Lab Relic into your hand and the rest on the bottom.',
      'Return none.',
    ],
    'PR12 Lab Relic goes to your hand and Zurgo and Ojutai stays on the battlefield.',
    {
      p1Hand: [],
      p1Field: [card(ZURGO)],
      p1LibraryTop: [SHOCK, RELIC, BEAR],
      prepared: COMBAT,
    },
  ),
  entry(
    ZURGO,
    'multiplayer',
    'Zurgo and Ojutai: simultaneous Dragon damage to two players triggers twice',
    [3],
    [
      'Attack P2 with Zurgo and Ojutai and P3 with PR12 Lab Dragon.',
      'Put one card from each look-three into your hand and keep the rest in current order.',
      'For the P2 damage trigger, return Zurgo and Ojutai.',
      'For the P3 damage trigger, return PR12 Lab Dragon.',
    ],
    'P2 takes 4 and P3 takes 4. Both Dragon damage triggers resolve: two cards go to your hand, and each trigger can return only the Dragon that damaged its event player.',
    {
      p1Hand: [],
      p1Field: [card(ZURGO), DRAGON],
      p1LibraryTop: [RELIC, BEAR, SHOCK, TRINKET, DRAGON, card(ZURGO)],
      prepared: COMBAT,
    },
  ),

  // PR12.05 Bloomvine Regent // Claim Territory
  entry(
    BLOOMVINE,
    'claim-territory',
    'Claim Territory: one Forest to the battlefield tapped, one to hand',
    ['face-1'],
    ['Cast Claim Territory.', 'Choose two basic Forests.'],
    'One Forest enters tapped, one goes to your hand, and Bloomvine Regent is shuffled into your library.',
    {
      p1Hand: [card(BLOOMVINE)],
      p1Lands: lands('Forest', 3),
    },
  ),
  entry(
    BLOOMVINE,
    'enters',
    'Bloomvine Regent: the Dragon enters and you gain 3 life',
    [1, 2],
    ['Cast Bloomvine Regent.'],
    'Bloomvine Regent enters and you gain 3 life.',
    {
      p1Hand: [card(BLOOMVINE)],
      p1Lands: lands('Forest', 5),
    },
  ),

  // PR12.06 Marang River Regent // Coil and Catch
  entry(
    MARANG,
    'coil-and-catch',
    'Coil and Catch: draw three, then discard a card',
    ['face-1'],
    ['Cast Coil and Catch.', 'Discard PR12 Lab Trinket.'],
    'You draw three cards, discard one, and Marang River Regent is shuffled into your library.',
    {
      p1Hand: [card(MARANG)],
      p1Lands: lands('Island', 4),
    },
  ),
  entry(
    MARANG,
    'enters',
    'Marang River Regent: return up to two nonland permanents',
    [1, 2],
    ['Cast Marang River Regent.', 'Target P2’s PR12 Lab Bear and PR12 Lab Relic.'],
    'Both of P2’s permanents return to P2’s hand.',
    {
      p1Hand: [card(MARANG)],
      p1Lands: lands('Island', 6),
      p2Field: [BEAR, RELIC],
    },
  ),

  // PR12.07 Monster Manual // Zoological Study
  entry(
    MANUAL,
    'zoological-study',
    'Zoological Study: mill five, return a creature, then cast the Book from exile',
    ['face-1'],
    [
      'Cast Zoological Study.',
      'Return PR12 Lab Bear from the milled cards.',
      'Cast Monster Manual from exile.',
    ],
    'PR12 Lab Bear returns to your hand, and Monster Manual is cast from exile onto the battlefield.',
    {
      p1Hand: [card(MANUAL)],
      p1Lands: lands('Forest', 7),
      p1LibraryTop: [SHOCK, BEAR, RELIC, DRAGON],
    },
  ),
  entry(
    MANUAL,
    'put-creature',
    'Monster Manual: put a creature card from your hand onto the battlefield',
    [1],
    ['Activate Monster Manual.', 'Put PR12 Lab Dragon onto the battlefield.'],
    'PR12 Lab Dragon enters the battlefield without being cast.',
    {
      p1Hand: [DRAGON],
      p1Field: [card(MANUAL)],
      p1Lands: lands('Forest', 2),
    },
  ),
];

export const PR12_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

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

/** The clause ids a PR12 card's Oracle text declares: front lines, then spell-face lines. */
export function pr12ClauseIds(oracle: OracleCard): string[] {
  const base = `pr12-${slug(oracle.name)}-clause-`;
  return [
    ...oracle.oracleText.split('\n').map((_, index) => `${base}${index + 1}`),
    ...(oracle.backFace?.oracleText.split('\n') ?? []).map(
      (_, index) => `${base}face-${index + 1}`,
    ),
  ];
}

/** Source-pinned prepared Card Test Lab scenarios for the seven reopened PR12 cards. */
export function pr12Scenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown PR12 scenario ${id}`);
  const source = pin(def.cardName);
  const p1Field = (def.p1Field ?? []).map(placed);
  const p2Field = (def.p2Field ?? []).map(placed);
  const p1Lands = def.p1Lands ?? [];
  const p2Lands = def.p2Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'PR12 support land'));
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR12 filler land'),
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
    deckId: `pr12-${seat}`,
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

  const seed = `pr12-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  const base = `pr12-${slug(def.cardName)}-clause-`;
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
          decisionProviderOverrides: {
            [def.opponent.seat]: opponentProvider(def.opponent, () => engine),
          },
        }
      : {}),
  };
}
