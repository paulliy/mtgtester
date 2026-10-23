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
        '../../../../packages/engine/tests/fixtures/coverage-pr11-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;

for (const entry of pins)
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`PR11b Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR11b Oracle pin ${name}`);
  return found;
}
const card = (name: string): OracleCard => pin(name).card;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = [
  'Artifact',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
];

/** A source-free Card Test Lab support card; the Oracle text is interpreted by the real engine. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
  loyalty: string | null = null,
): OracleCard {
  const base = supportCard('Forest', 'PR11b support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pr11b-${slug(name)}`;
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
    loyalty,
    keywords: [],
    isBasicLand: false,
  };
}

export const SHOCK = lab(
  'PR11b Lab Shock',
  'Instant',
  '{R}',
  'PR11b Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const DRAIN = lab('PR11b Lab Drain', 'Instant', '{B}', 'You lose 2 life.', ['B']);
export const DIVINATION = lab('PR11b Lab Divination', 'Instant', '{1}{U}', 'Draw two cards.', [
  'U',
]);
export const CANTRIP = lab('PR11b Lab Cantrip', 'Instant', '{U}', 'Draw a card.', ['U']);
export const BEAR = lab('PR11b Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const RED_BEAR = lab('PR11b Lab Red Bear', 'Creature — Bear', '{R}', '', ['R'], ['2', '2']);
export const GIANT = lab('PR11b Lab Giant', 'Creature — Giant', '{4}{G}', '', ['G'], ['4', '4']);
export const PINGER = lab('PR11b Lab Pinger', 'Creature — Goblin', '{1}{R}', '', ['R'], ['1', '1']);
export const RELIC = lab('PR11b Lab Relic', 'Artifact', '{3}', '', []);
export const BAUBLE = lab('PR11b Lab Bauble', 'Artifact', '{1}', '', []);
export const CHARM = lab('PR11b Lab Charm', 'Enchantment', '{1}{W}', '', ['W']);
export const WALKER = lab(
  'PR11b Lab Walker',
  'Legendary Planeswalker — Lab',
  '{3}',
  '',
  [],
  null,
  '3',
);
export const SECOND_WALKER = lab(
  'PR11b Lab Second Walker',
  'Legendary Planeswalker — Lab',
  '{3}',
  '',
  [],
  null,
  '2',
);
/**
 * Always in P1's hand: a free spell P1 can cast at any time it has priority, so the viewer is
 * still given priority after the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('PR11b Lab Trinket', 'Artifact', '{0}', '', []);

const SUPPORT_CARDS = [
  SHOCK,
  DRAIN,
  DIVINATION,
  CANTRIP,
  BEAR,
  RED_BEAR,
  GIANT,
  PINGER,
  RELIC,
  BAUBLE,
  CHARM,
  WALKER,
  SECOND_WALKER,
  TRINKET,
];

/** A permanent arranged on the battlefield, optionally with counters or tapped. */
interface Placed {
  card: OracleCard;
  counters?: Record<string, number>;
  tapped?: boolean;
}
type FieldEntry = OracleCard | Placed;
const placed = (entry: FieldEntry): Placed => ('card' in entry ? entry : { card: entry });

/**
 * What a scripted opponent does the first time it holds priority, with an empty stack, while the
 * action is available.
 */
export interface OpponentPlan {
  seat: PlayerId;
  /** Cast this spell. */
  cast?: OracleCard;
  /**
   * Preferred choice per target slot: a seat id or a permanent name. When it is not a legal
   * target, the first legal option other than the opponent's own seat is taken.
   */
  targets?: string[];
  /** Options the opponent picks in non-priority decisions, matched against the description. */
  answers?: RegExp[];
  /** Attack the named permanent or seat with every creature this opponent can attack with. */
  attack?: string;
}

interface Def {
  id: string;
  /** The id's card part: also names the clauses. */
  slug: string;
  cardName: string;
  title: string;
  /** The manifest clauses (`pr11b-<slug>-clause-N`) this scenario exercises. */
  lines: number[];
  instructions: string[];
  expectedOutcome: string;
  p1Hand: OracleCard[];
  p1Field?: FieldEntry[];
  p1Graveyard?: OracleCard[];
  /** Cards moved to the top of P1's library, top first, below the one P1 draws for the turn. */
  p1Top?: OracleCard[];
  /** Basic lands P1 controls, by name. */
  p1Lands?: string[];
  p2Hand?: OracleCard[];
  p2Field?: FieldEntry[];
  p2Lands?: string[];
  opponent?: OpponentPlan;
  prepared?: Partial<PreparedScenarioSpec>;
}

const entry = (
  id: string,
  cardName: string,
  title: string,
  lines: number[],
  instructions: string[],
  expectedOutcome: string,
  rest: Omit<
    Def,
    'id' | 'slug' | 'cardName' | 'title' | 'lines' | 'instructions' | 'expectedOutcome'
  >,
): Def => ({
  id,
  slug: id.slice('pr11b-'.length, id.indexOf('-viewer-')),
  cardName,
  title,
  lines,
  instructions,
  expectedOutcome,
  ...rest,
});

const lands = (name: string, count: number) => Array.from({ length: count }, () => name);
/** Run the production untap, upkeep, draw and main of P2, P3, P4 and then P1's next turn. */
const THROUGH_YOUR_NEXT_TURN: Partial<PreparedScenarioSpec> = { continueThroughPrecombatMains: 4 };
const P2_CASTS = (spell: OracleCard, target?: string): OpponentPlan => ({
  seat: 'P2',
  cast: spell,
  ...(target === undefined ? {} : { targets: [target] }),
});

const MALAKIR = 'Malakir Rebirth // Malakir Mire';
const VALAKUT = 'Valakut Awakening // Valakut Stoneforge';
const DUSKMAGE = "Defacing Duskmage // Vandal's Edit";
const DYNASTORIAN = 'Eiganjo Dynastorian // Replenish';
const ARCHAIC = 'Wandering Archaic // Explore the Vastlands';
const ROOM = "Dollmaker's Shop // Porcelain Gallery";
const MILA = 'Mila, Crafty Companion // Lukka, Wayward Bonder';
const LANDING = "Legion's Landing // Adanto, the First Fort";

const DEFS: Def[] = [
  // PR11b.01 Malakir Rebirth // Malakir Mire
  entry(
    'pr11b-malakir-rebirth-viewer-return',
    MALAKIR,
    'Malakir Rebirth: lose 2 life, then the creature returns when it dies',
    [1],
    [
      'Cast Malakir Rebirth targeting your PR11b Lab Bear.',
      'Cast PR11b Lab Shock at the Bear to kill it.',
    ],
    'You lose 2 life. When the Bear dies this turn it returns to the battlefield tapped.',
    {
      p1Hand: [card(MALAKIR), SHOCK],
      p1Field: [BEAR],
      p1Lands: ['Swamp', 'Mountain'],
    },
  ),
  entry(
    'pr11b-malakir-rebirth-viewer-land-face',
    MALAKIR,
    'Malakir Rebirth: play the back face Malakir Mire as a land',
    [2],
    ['Play Malakir Mire (back face) as your land for the turn.'],
    'Malakir Mire enters the battlefield tapped.',
    { p1Hand: [card(MALAKIR)] },
  ),

  // PR11b.02 Valakut Awakening // Valakut Stoneforge
  entry(
    'pr11b-valakut-awakening-viewer-redraw',
    VALAKUT,
    'Valakut Awakening: put two cards on the bottom, draw three',
    [1],
    [
      'Cast Valakut Awakening.',
      'Put PR11b Lab Bear and PR11b Lab Relic on the bottom of your library, then confirm.',
    ],
    'Two cards go to the bottom of your library and you draw three cards.',
    { p1Hand: [card(VALAKUT), BEAR, RELIC], p1Lands: lands('Mountain', 3) },
  ),
  entry(
    'pr11b-valakut-awakening-viewer-land-face',
    VALAKUT,
    'Valakut Awakening: play the back face Valakut Stoneforge as a land',
    [2],
    ['Play Valakut Stoneforge (back face) as your land for the turn.'],
    'Valakut Stoneforge enters the battlefield tapped.',
    { p1Hand: [card(VALAKUT)] },
  ),

  // PR11b.03 Defacing Duskmage // Vandal's Edit
  entry(
    'pr11b-defacing-duskmage-viewer-prepared',
    DUSKMAGE,
    "Defacing Duskmage: an opponent's second draw prepares it",
    [2, 3],
    [
      'Pass priority; P2 casts PR11b Lab Divination and draws two cards.',
      "Cast the prepared copy of Vandal's Edit.",
    ],
    "Duskmage becomes prepared on P2's second draw. The Vandal's Edit copy draws you two cards and each player loses 2 life.",
    {
      p1Hand: [],
      p1Field: [card(DUSKMAGE)],
      p1Lands: ['Plains', 'Swamp', 'Forest'],
      p2Hand: [DIVINATION],
      p2Lands: ['Island', 'Island'],
      opponent: P2_CASTS(DIVINATION),
    },
  ),
  entry(
    'pr11b-defacing-duskmage-viewer-first-draw',
    DUSKMAGE,
    "Defacing Duskmage: an opponent's first draw does not prepare it",
    [2],
    ['Pass priority; P2 casts PR11b Lab Cantrip and draws one card.'],
    'It is only P2’s first draw this turn, so Duskmage does not become prepared.',
    {
      p1Hand: [],
      p1Field: [card(DUSKMAGE)],
      p1Lands: ['Plains', 'Swamp', 'Forest'],
      p2Hand: [CANTRIP],
      p2Lands: ['Island'],
      opponent: P2_CASTS(CANTRIP),
    },
  ),

  // PR11b.04 Eiganjo Dynastorian // Replenish
  entry(
    'pr11b-eiganjo-dynastorian-viewer-prepared',
    DYNASTORIAN,
    'Eiganjo Dynastorian: attacking with two creatures prepares it',
    [2, 3],
    [
      'Attack P2 with Eiganjo Dynastorian and PR11b Lab Bear.',
      'In your second main phase, cast the prepared copy of Replenish.',
    ],
    'Dynastorian becomes prepared. The Replenish copy returns PR11b Lab Charm from your graveyard to the battlefield.',
    {
      p1Hand: [],
      p1Field: [card(DYNASTORIAN), BEAR],
      p1Graveyard: [CHARM],
      p1Lands: lands('Plains', 4),
      prepared: { continueThroughCombat: true, continueToPostcombatMain: true },
    },
  ),
  entry(
    'pr11b-eiganjo-dynastorian-viewer-one-attacker',
    DYNASTORIAN,
    'Eiganjo Dynastorian: attacking alone does not prepare it',
    [2],
    ['Attack P2 with Eiganjo Dynastorian only.'],
    'Only one creature attacks, so Dynastorian does not become prepared and Replenish cannot be cast.',
    {
      p1Hand: [],
      p1Field: [card(DYNASTORIAN), BEAR],
      p1Graveyard: [CHARM],
      p1Lands: lands('Plains', 4),
      prepared: { continueThroughCombat: true, continueToPostcombatMain: true },
    },
  ),

  // PR11b.05 Wandering Archaic // Explore the Vastlands
  entry(
    'pr11b-wandering-archaic-viewer-copy',
    ARCHAIC,
    "Wandering Archaic: copy an opponent's instant they don't pay for",
    [1],
    [
      'Pass priority; P2 casts PR11b Lab Shock and cannot pay {2} for Wandering Archaic.',
      'Choose to copy the spell and retarget the copy at P2.',
    ],
    'P2 does not pay, so you copy PR11b Lab Shock and may choose new targets for the copy: P2 takes the copy’s 2 damage and P3 the original’s.',
    {
      p1Hand: [],
      p1Field: [card(ARCHAIC), BEAR],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_CASTS(SHOCK, 'P3'),
    },
  ),
  entry(
    'pr11b-wandering-archaic-viewer-paid',
    ARCHAIC,
    'Wandering Archaic: no copy when the opponent pays {2}',
    [1],
    ['Pass priority; P2 casts PR11b Lab Shock and pays {2} for Wandering Archaic.'],
    'P2 pays {2}, so Wandering Archaic does not copy the spell.',
    {
      p1Hand: [],
      p1Field: [card(ARCHAIC), BEAR],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain', 'Island', 'Island'],
      opponent: { ...P2_CASTS(SHOCK, 'P3'), answers: [/^Pay \{2\}$/] },
    },
  ),

  // PR11b.06 Wear // Tear
  entry(
    'pr11b-wear-tear-viewer-fused',
    'Wear // Tear',
    'Wear // Tear: fuse both halves from your hand',
    [1, 2, 3],
    ['Cast Wear // Tear fused for {1}{R}{W}, targeting PR11b Lab Relic and PR11b Lab Charm.'],
    'Wear destroys the artifact and Tear destroys the enchantment.',
    {
      p1Hand: [card('Wear // Tear')],
      p1Lands: ['Mountain', 'Plains', 'Forest'],
      p2Field: [RELIC, CHARM],
    },
  ),
  entry(
    'pr11b-wear-tear-viewer-half',
    'Wear // Tear',
    'Wear // Tear: cast only the Tear half',
    [2],
    ['Cast only Tear for {W}, targeting PR11b Lab Charm.'],
    'Only the enchantment is destroyed; the artifact stays.',
    {
      p1Hand: [card('Wear // Tear')],
      p1Lands: ['Plains'],
      p2Field: [RELIC, CHARM],
    },
  ),

  // PR11b.07 The War in Heaven
  entry(
    'pr11b-the-war-in-heaven-viewer-chapter-one',
    'The War in Heaven',
    'The War in Heaven: chapter I draws three and loses 3 life',
    [1, 2],
    ['Cast The War in Heaven for {3}{B}{B}{B}.'],
    'It enters with a lore counter. Chapter I makes you draw three cards and lose 3 life.',
    { p1Hand: [card('The War in Heaven')], p1Lands: lands('Swamp', 6) },
  ),
  entry(
    'pr11b-the-war-in-heaven-viewer-chapter-three',
    'The War in Heaven',
    'The War in Heaven: chapter III returns creatures as artifacts',
    [1, 4],
    [
      'Pass through to your next precombat main phase, when the Saga gets its third lore counter.',
      'Choose all three creature cards in your graveyard as chapter III’s targets.',
    ],
    'The creature cards (total mana value 8) return with necrodermis counters as artifacts, and the Saga is sacrificed.',
    {
      p1Hand: [],
      p1Field: [{ card: card('The War in Heaven'), counters: { lore: 2 } }],
      p1Graveyard: [BEAR, RED_BEAR, GIANT],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11b.08 Intermediate Chirography
  entry(
    'pr11b-intermediate-chirography-viewer-level-two',
    'Intermediate Chirography',
    'Intermediate Chirography: level 2 puts a counter when you lose life',
    [2, 3],
    [
      'Gain Class level 2 for {1}{B} at sorcery speed.',
      'Cast PR11b Lab Drain so you lose 2 life; the trigger’s only target, PR11b Lab Bear, is chosen for you.',
    ],
    'At level 2, the first life loss each turn puts a +1/+1 counter on PR11b Lab Bear.',
    {
      p1Hand: [DRAIN],
      p1Field: [card('Intermediate Chirography'), BEAR],
      p1Lands: lands('Swamp', 3),
    },
  ),
  entry(
    'pr11b-intermediate-chirography-viewer-level-one',
    'Intermediate Chirography',
    'Intermediate Chirography: no counter at level 1',
    [3],
    ['Cast PR11b Lab Drain so you lose 2 life, without gaining level 2.'],
    'At level 1 losing life does nothing: PR11b Lab Bear gets no counter.',
    {
      p1Hand: [DRAIN],
      p1Field: [card('Intermediate Chirography'), BEAR],
      p1Lands: lands('Swamp', 1),
    },
  ),

  // PR11b.09 Urza's Saga
  entry(
    'pr11b-urza-s-saga-viewer-construct',
    "Urza's Saga",
    "Urza's Saga: chapter II lets it make a growing Construct",
    [2, 3],
    [
      "Play Urza's Saga; chapter I lets it tap for {C}.",
      'Pass through to your next precombat main phase for chapter II.',
      'Activate {2}, {T} to create a Construct.',
    ],
    'The Construct is 0/0 plus one for each artifact you control: with PR11b Lab Relic and itself, it is 2/2.',
    {
      p1Hand: [card("Urza's Saga")],
      p1Field: [RELIC],
      p1Lands: lands('Forest', 2),
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),
  entry(
    'pr11b-urza-s-saga-viewer-chapter-three',
    "Urza's Saga",
    "Urza's Saga: chapter III fetches a cheap artifact and is sacrificed",
    [1, 4],
    [
      'Pass through to your next precombat main phase, when the Saga gets its third lore counter.',
      'Search for PR11b Lab Bauble; PR11b Lab Relic is not offered.',
    ],
    'PR11b Lab Bauble ({1}) enters the battlefield, and Urza’s Saga is sacrificed.',
    {
      p1Hand: [],
      p1Field: [{ card: card("Urza's Saga"), counters: { lore: 2 } }],
      p1Top: [BAUBLE, RELIC],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11b.10 Legion's Landing // Adanto, the First Fort
  entry(
    'pr11b-legion-s-landing-viewer-transform',
    LANDING,
    "Legion's Landing: attacking with three creatures transforms it",
    [1, 2],
    ['Attack P2 with PR11b Lab Bear, PR11b Lab Red Bear and PR11b Lab Pinger.'],
    "Legion's Landing transforms into Adanto, the First Fort.",
    {
      p1Hand: [],
      p1Field: [card(LANDING), BEAR, RED_BEAR, PINGER],
      prepared: { continueThroughCombat: true },
    },
  ),
  entry(
    'pr11b-legion-s-landing-viewer-two-attackers',
    LANDING,
    "Legion's Landing: two attackers do not transform it",
    [2],
    ['Attack P2 with only PR11b Lab Bear and PR11b Lab Red Bear.'],
    "Only two creatures attack, so Legion's Landing stays as it is.",
    {
      p1Hand: [],
      p1Field: [card(LANDING), BEAR, RED_BEAR, PINGER],
      prepared: { continueThroughCombat: true },
    },
  ),

  // PR11b.11 Dollmaker's Shop // Porcelain Gallery
  entry(
    'pr11b-dollmaker-s-shop-viewer-unlock',
    ROOM,
    "Dollmaker's Shop: unlock Porcelain Gallery",
    [2, 3],
    [
      "Cast the Room as Dollmaker's Shop for {1}{W}.",
      'Use the "Unlock Porcelain Gallery" special action for {4}{W}{W}.',
    ],
    'Porcelain Gallery unlocks: each creature you control has base power and toughness equal to the number of creatures you control (3/3 with three).',
    {
      p1Hand: [card(ROOM)],
      p1Field: [BEAR, RED_BEAR, PINGER],
      p1Lands: [...lands('Plains', 6), ...lands('Forest', 2)],
    },
  ),
  entry(
    'pr11b-dollmaker-s-shop-viewer-toy-attack',
    ROOM,
    "Dollmaker's Shop: attacking a player creates a Toy",
    [1],
    [
      "Cast the Room as Dollmaker's Shop for {1}{W}.",
      'Attack P2 with PR11b Lab Bear and PR11b Lab Red Bear.',
    ],
    'Non-Toy creatures attacked a player, so you create a 1/1 white Toy artifact creature token. An attack on a planeswalker would not.',
    {
      p1Hand: [card(ROOM)],
      p1Field: [BEAR, RED_BEAR],
      p1Lands: lands('Plains', 2),
      prepared: { continueThroughCombat: true },
    },
  ),

  // PR11b.12 Mila, Crafty Companion // Lukka, Wayward Bonder
  entry(
    'pr11b-mila-crafty-companion-viewer-walker-attack',
    MILA,
    'Mila: an attack on a planeswalker adds loyalty to each of yours',
    [1],
    ['Pass priority through to P2’s turn; P2 attacks PR11b Lab Walker with PR11b Lab Bear.'],
    'Mila puts a loyalty counter on each planeswalker you control: PR11b Lab Walker and PR11b Lab Second Walker each gain one.',
    {
      p1Hand: [],
      p1Field: [card(MILA), WALKER, SECOND_WALKER],
      p2Field: [BEAR],
      opponent: { seat: 'P2', attack: 'PR11b Lab Walker' },
      prepared: { continueThroughNextCombat: true },
    },
  ),
  entry(
    'pr11b-mila-crafty-companion-viewer-lukka',
    MILA,
    'Lukka, Wayward Bonder: -2 returns a creature with haste',
    [4],
    [
      'Cast the back face, Lukka, Wayward Bonder, for {4}{R}{R}.',
      "Activate Lukka's -2 targeting PR11b Lab Bear in your graveyard.",
    ],
    'PR11b Lab Bear returns to the battlefield with haste and Lukka drops to 3 loyalty.',
    {
      p1Hand: [card(MILA)],
      p1Graveyard: [BEAR],
      p1Lands: [...lands('Mountain', 2), ...lands('Forest', 4)],
    },
  ),
];

export const PR11B_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

/** The scripted opponent: takes its planned action once, then passes. */
function opponentProvider(plan: OpponentPlan, engine: () => Engine) {
  let done = false;
  const nameOf = (objectId: string) =>
    engine()
      .getState()
      .battlefield.find((perm) => perm.id === objectId)?.name;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const attack = request.legalActions.find((action) => action.type === 'attackDeclaration');
      if (plan.attack !== undefined && attack !== undefined)
        return {
          requestId: request.requestId,
          actionId: attack.id,
          targets: (attack.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice:
              slot.options.find(
                (option) => option === plan.attack || nameOf(option) === plan.attack,
              ) ?? '__no_attack__',
          })),
        };
      if (pass === undefined) {
        // A non-priority decision: take the first option an answer names.
        for (const pattern of plan.answers ?? []) {
          const found = request.legalActions.find((candidate) =>
            pattern.test(candidate.description),
          );
          if (found !== undefined) return { requestId: request.requestId, actionId: found.id };
        }
        return { requestId: request.requestId, actionId: request.legalActions[0]!.id };
      }
      // It acts only with an empty stack: never in response to the viewer's spell.
      const action =
        done || plan.cast === undefined || engine().getState().stack.length > 0
          ? undefined
          : request.legalActions.find(
              (candidate) =>
                candidate.type === 'castSpell' && candidate.description.includes(plan.cast!.name),
            );
      if (action === undefined) return { requestId: request.requestId, actionId: pass.id };
      done = true;
      const battlefield = engine().getState().battlefield;
      return {
        requestId: request.requestId,
        actionId: action.id,
        targets: (action.targets ?? []).map((slot) => {
          const want = plan.targets?.[slot.slot] ?? '';
          const byName = battlefield.find(
            (perm) => perm.name === want && slot.options.includes(perm.id),
          );
          return {
            slot: slot.slot,
            choice: slot.options.includes(want)
              ? want
              : (byName?.id ??
                slot.options.find((option) => option !== plan.seat) ??
                slot.options[0]!),
          };
        }),
      };
    },
  };
}

function battlefieldGroups(playerId: PlayerId, entries: FieldEntry[], basics: string[]) {
  const plain = [...basics];
  const groups: PreparedScenarioSpec['battlefield'] = [];
  for (const item of entries.map(placed)) {
    if (item.counters === undefined && item.tapped === undefined) plain.push(item.card.name);
    else
      groups.push({
        playerId,
        cardNames: [item.card.name],
        ...(item.counters !== undefined ? { counters: item.counters } : {}),
        ...(item.tapped !== undefined ? { tapped: item.tapped } : {}),
      });
  }
  return plain.length > 0 ? [{ playerId, cardNames: plain }, ...groups] : groups;
}

/** Source-pinned prepared Card Test Lab scenarios for the PR11b layout cards. */
export function pr11bScenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown PR11b scenario ${id}`);
  const source = pin(def.cardName);
  const p1Field = (def.p1Field ?? []).map(placed);
  const p2Field = (def.p2Field ?? []).map(placed);
  const p1Lands = def.p1Lands ?? [];
  const p2Lands = def.p2Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'PR11b support land'));
  for (const support of [...SUPPORT_CARDS, source.card]) cardNamed.set(support.name, support);
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR11b filler land'),
    );

  const p1Hand = [...def.p1Hand, TRINKET];
  const p1Cards = [
    ...p1Hand,
    ...p1Field.map((item) => item.card),
    ...(def.p1Graveyard ?? []),
    ...(def.p1Top ?? []),
    ...named(p1Lands),
  ];
  const p2Cards = [...(def.p2Hand ?? []), ...p2Field.map((item) => item.card), ...named(p2Lands)];

  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr11b-${seat}`,
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
    ...(def.p1Graveyard?.length
      ? {
          graveyard: [
            { playerId: 'P1' as const, cardNames: def.p1Graveyard.map((item) => item.name) },
          ],
        }
      : {}),
    // The first library card is the one P1 draws for the turn, so the searched-for cards sit below.
    ...(def.p1Top?.length
      ? {
          libraryTop: [
            {
              playerId: 'P1' as const,
              cardNames: ['Forest', ...def.p1Top.map((item) => item.name)],
            },
          ],
        }
      : {}),
    ...def.prepared,
  };

  const seed = `pr11b-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  return {
    metadata: {
      id,
      version: 1,
      title: def.title,
      instructions: def.instructions,
      expectedOutcome: def.expectedOutcome,
      oracleSha256: source.sha256,
      clauseIds: def.lines.map((line) => `pr11b-${def.slug}-clause-${line}`),
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
