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
    throw new Error(`PR11 Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR11 Oracle pin ${name}`);
  return found;
}
const card = (name: string): OracleCard => pin(name).card;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'];
const KEYWORD_TEXT = new Set(['Flash', 'Hexproof']);

/** A source-free Card Test Lab support card; the Oracle text is interpreted by the real engine. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
): OracleCard {
  const base = supportCard('Forest', 'PR11 support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pr11-${slug(name)}`;
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
  'PR11 Lab Shock',
  'Instant',
  '{R}',
  'PR11 Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const FIRE_BOLT = lab(
  'PR11 Lab Fire Bolt',
  'Instant',
  '{R}{R}',
  'PR11 Lab Fire Bolt deals 3 damage to any target.',
  ['R'],
);
export const GOLD_BOLT = lab(
  'PR11 Lab Gold Bolt',
  'Instant',
  '{R}{G}',
  'PR11 Lab Gold Bolt deals 2 damage to any target.',
  ['R', 'G'],
);
export const BEAR = lab('PR11 Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const RED_BEAR = lab('PR11 Lab Red Bear', 'Creature — Bear', '{R}', '', ['R'], ['2', '2']);
export const WARDED_BEAR = lab(
  'PR11 Lab Hexproof Bear',
  'Creature — Bear',
  '{1}{G}',
  'Hexproof',
  ['G'],
  ['2', '2'],
);
export const PINGER = lab(
  'PR11 Lab Pinger',
  'Creature — Goblin',
  '{1}{R}',
  '{T}: PR11 Lab Pinger deals 1 damage to any target.',
  ['R'],
  ['1', '1'],
);
export const RELIC = lab('PR11 Lab Relic', 'Artifact', '{3}', '', []);
/**
 * Always in P1's hand: a free spell P1 can cast at any time it has priority, so the viewer is
 * still given priority after the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('PR11 Lab Trinket', 'Artifact', '{0}', '', []);

const SUPPORT_CARDS = [
  SHOCK,
  FIRE_BOLT,
  GOLD_BOLT,
  BEAR,
  RED_BEAR,
  WARDED_BEAR,
  PINGER,
  RELIC,
  TRINKET,
];

/** A permanent arranged on the battlefield, optionally with counters, tapped, or attached. */
interface Placed {
  card: OracleCard;
  counters?: Record<string, number>;
  tapped?: boolean;
  /** Name of a permanent the same player controls that this Aura enchants. */
  attachedTo?: string;
}
type FieldEntry = OracleCard | Placed;
const placed = (entry: FieldEntry): Placed => ('card' in entry ? entry : { card: entry });

/**
 * What a scripted opponent does the first time it holds priority, with an empty stack, while the
 * action is available.
 */
export interface OpponentPlan {
  seat: PlayerId;
  /** Cast this spell, or activate the ability whose description contains `activate`. */
  cast?: OracleCard;
  activate?: string;
  /**
   * Preferred choice per target slot: a seat id or a permanent name. When it is not a legal
   * target, the first legal option other than the opponent's own seat is taken.
   */
  targets: string[];
}

interface Def {
  id: string;
  cardName: string;
  title: string;
  /** 1-based Oracle lines this scenario exercises. */
  lines: number[];
  instructions: string[];
  expectedOutcome: string;
  p1Hand: OracleCard[];
  p1Field?: FieldEntry[];
  p1Graveyard?: OracleCard[];
  /** Basic lands P1 controls, by name. */
  p1Lands?: string[];
  /** Cards left in P1's library; 24 unless a scenario needs an empty library. */
  p1Library?: number;
  p2Hand?: OracleCard[];
  p2Field?: FieldEntry[];
  p2Graveyard?: OracleCard[];
  p2Lands?: string[];
  opponent?: OpponentPlan;
  lifeTotals?: Array<{ playerId: PlayerId; life: number }>;
  prepared?: Partial<PreparedScenarioSpec>;
}

const entry = (
  cardName: string,
  kind: string,
  title: string,
  lines: number[],
  instructions: string[],
  expectedOutcome: string,
  rest: Omit<Def, 'id' | 'cardName' | 'title' | 'lines' | 'instructions' | 'expectedOutcome'>,
): Def => ({
  id: `pr11-${slug(cardName)}-viewer-${kind}`,
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
const P2_SHOCKS = (target: string): OpponentPlan => ({
  seat: 'P2',
  cast: SHOCK,
  targets: [target],
});

const DEFS: Def[] = [
  // PR11.01 Arcane Lighthouse
  entry(
    'Arcane Lighthouse',
    'positive',
    'Arcane Lighthouse: strip hexproof, then target the creature',
    [2],
    [
      'Activate Arcane Lighthouse’s {1}, {T} ability.',
      'Cast PR11 Lab Shock targeting P2’s PR11 Lab Hexproof Bear.',
    ],
    'The Lighthouse removes hexproof until end of turn, so Lab Shock can target the bear and kills it.',
    {
      p1Hand: [SHOCK],
      p1Field: [card('Arcane Lighthouse')],
      p1Lands: lands('Mountain', 2),
      p2Field: [WARDED_BEAR],
    },
  ),
  entry(
    'Arcane Lighthouse',
    'negative',
    'Arcane Lighthouse: hexproof stands without the activation',
    [2],
    ['Cast PR11 Lab Shock without activating the Lighthouse.'],
    'P2’s PR11 Lab Hexproof Bear is not a legal target, and it survives.',
    {
      p1Hand: [SHOCK],
      p1Field: [card('Arcane Lighthouse')],
      p1Lands: lands('Mountain', 2),
      p2Field: [WARDED_BEAR],
    },
  ),

  // PR11.03 Smokestack
  entry(
    'Smokestack',
    'soot',
    'Smokestack: add a soot counter in your upkeep, then sacrifice for it',
    [1, 2],
    [
      'Pass through the other players’ turns.',
      'In your upkeep, put a soot counter on Smokestack, then sacrifice one permanent.',
    ],
    'Smokestack gets one soot counter and you sacrifice one permanent of your choice for it.',
    {
      p1Hand: [],
      p1Field: [card('Smokestack'), BEAR],
      p1Lands: lands('Forest', 2),
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),
  entry(
    'Smokestack',
    'sacrifice',
    'Smokestack: each player sacrifices for each soot counter',
    [2],
    ['Pass priority; each opponent’s upkeep makes that player sacrifice a permanent.'],
    'With one soot counter, P2 sacrifices one of its two lands in its upkeep; P3 and P4 control nothing to sacrifice.',
    {
      p1Hand: [],
      p1Field: [{ card: card('Smokestack'), counters: { soot: 1 } }],
      p2Lands: ['Mountain', 'Forest'],
      prepared: { continueThroughUpkeeps: 3 },
    },
  ),

  // PR11.05 Angel's Grace
  entry(
    "Angel's Grace",
    'split-second',
    "Angel's Grace: no spells can be cast in response",
    [1],
    [
      'Cast PR11 Lab Trinket: P2 is given priority and could respond with Lab Shock.',
      "Once it resolves, cast Angel's Grace and pass priority.",
    ],
    'While Angel’s Grace is on the stack, P2 is offered no spell to cast; it casts Lab Shock only after Grace resolves.',
    {
      p1Hand: [card("Angel's Grace")],
      p1Lands: ['Plains'],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS('P3'),
    },
  ),
  entry(
    "Angel's Grace",
    'life-floor',
    "Angel's Grace: damage can't take you below 1",
    [2],
    ["At 2 life, cast Angel's Grace; P2 then casts PR11 Lab Shock at you."],
    'Lab Shock would leave you at 0, but Angel’s Grace reduces your life total to 1 instead.',
    {
      p1Hand: [card("Angel's Grace")],
      p1Lands: ['Plains'],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS('P1'),
      lifeTotals: [{ playerId: 'P1', life: 2 }],
    },
  ),

  // PR11.08 Gut, True Soul Zealot
  entry(
    'Gut, True Soul Zealot',
    'sacrifice',
    'Gut: sacrifice a creature to make an attacking Skeleton',
    [1],
    ['Attack P2 with Gut.', 'Accept Gut’s trigger and sacrifice PR11 Lab Bear.'],
    'Lab Bear is sacrificed and a tapped, attacking 4/1 black Skeleton token with menace is created.',
    {
      p1Hand: [],
      p1Field: [card('Gut, True Soul Zealot'), BEAR],
      prepared: { continueThroughCombat: true },
    },
  ),
  entry(
    'Gut, True Soul Zealot',
    'decline',
    'Gut: decline the sacrifice',
    [1],
    ['Attack P2 with Gut and decline the trigger.'],
    'Nothing is sacrificed and no Skeleton token is created.',
    {
      p1Hand: [],
      p1Field: [card('Gut, True Soul Zealot'), BEAR],
      prepared: { continueThroughCombat: true },
    },
  ),

  // PR11.09 Out of the Tombs
  entry(
    'Out of the Tombs',
    'upkeep',
    'Out of the Tombs: add eon counters and mill in your upkeep',
    [1],
    ['Pass through the other players’ turns to your upkeep.'],
    'Out of the Tombs gets two eon counters and you mill two cards.',
    {
      p1Hand: [],
      p1Field: [card('Out of the Tombs')],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),
  entry(
    'Out of the Tombs',
    'empty-library',
    'Out of the Tombs: return a creature instead of drawing from an empty library',
    [2],
    ['With an empty library, pass through to your draw step.'],
    'Instead of drawing, PR11 Lab Bear returns from your graveyard to the battlefield and you do not lose.',
    {
      p1Hand: [],
      p1Field: [card('Out of the Tombs')],
      p1Graveyard: [BEAR],
      p1Library: 0,
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11.12 Caged Sun
  entry(
    'Caged Sun',
    'chosen-color',
    'Caged Sun: creatures of the chosen color get +1/+1',
    [1, 2],
    ['Cast Caged Sun and choose red as it enters.'],
    'PR11 Lab Red Bear becomes 3/3; the green PR11 Lab Bear stays 2/2.',
    {
      p1Hand: [card('Caged Sun')],
      p1Field: [RED_BEAR, BEAR],
      p1Lands: lands('Mountain', 6),
    },
  ),
  entry(
    'Caged Sun',
    'mana',
    'Caged Sun: a land adds one more mana of the chosen color',
    [3],
    [
      'Cast Caged Sun and choose red.',
      'Cast PR11 Lab Fire Bolt ({R}{R}) at P2 with your one remaining Mountain.',
    ],
    'The Mountain adds {R}{R}, so Fire Bolt is cast with a single land and P2 takes 3 damage.',
    {
      p1Hand: [card('Caged Sun'), FIRE_BOLT],
      p1Lands: lands('Mountain', 7),
    },
  ),
  entry(
    'Caged Sun',
    'other-color',
    'Caged Sun: no extra mana for another color',
    [3],
    ['Cast Caged Sun and choose green; one Mountain is left.'],
    'The Mountain adds only {R}, so PR11 Lab Fire Bolt cannot be cast.',
    {
      p1Hand: [card('Caged Sun'), FIRE_BOLT],
      p1Lands: lands('Mountain', 7),
    },
  ),

  // PR11.15 Mystic Remora
  entry(
    'Mystic Remora',
    'draw',
    'Mystic Remora: draw when an opponent casts a noncreature spell',
    [2],
    ['Pass priority so P2 casts PR11 Lab Shock, then draw from Remora’s trigger.'],
    'P2 cannot pay {4}, so you draw a card.',
    {
      p1Hand: [],
      p1Field: [card('Mystic Remora')],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS('P3'),
    },
  ),
  entry(
    'Mystic Remora',
    'pay-upkeep',
    'Mystic Remora: pay cumulative upkeep',
    [1],
    ['Pass through to your upkeep and pay {1} for the age counter.'],
    'Remora gets an age counter, you pay {1}, and it stays on the battlefield.',
    {
      p1Hand: [],
      p1Field: [card('Mystic Remora')],
      p1Lands: ['Island'],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),
  entry(
    'Mystic Remora',
    'skip-upkeep',
    'Mystic Remora: decline cumulative upkeep',
    [1],
    ['Pass through to your upkeep and decline to pay.'],
    'Remora gets an age counter and is sacrificed.',
    {
      p1Hand: [],
      p1Field: [card('Mystic Remora')],
      p1Lands: ['Island'],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11.16 Chrome Mox
  entry(
    'Chrome Mox',
    'imprint',
    'Chrome Mox: imprint a red card and tap for red',
    [1, 2],
    [
      'Cast Chrome Mox and exile PR11 Lab Red Bear from your hand.',
      'Tap the Mox for {R} and cast PR11 Lab Shock at P2.',
    ],
    'The Mox makes red mana from the exiled card, so Lab Shock is cast without lands and P2 takes 2.',
    { p1Hand: [card('Chrome Mox'), RED_BEAR, SHOCK] },
  ),
  entry(
    'Chrome Mox',
    'no-imprint',
    'Chrome Mox: no mana without an imprinted card',
    [1, 2],
    ['Cast Chrome Mox and decline to exile a card.'],
    'With nothing exiled the Mox adds no mana, so PR11 Lab Shock cannot be cast.',
    { p1Hand: [card('Chrome Mox'), RED_BEAR, SHOCK] },
  ),

  // PR11.17 Gemstone Caverns
  entry(
    'Gemstone Caverns',
    'luck',
    'Gemstone Caverns: a luck counter makes any color',
    [2],
    ['Tap Gemstone Caverns for {R} and cast PR11 Lab Shock at P2.'],
    'With a luck counter the Caverns add one mana of any color, so Lab Shock resolves.',
    {
      p1Hand: [SHOCK],
      p1Field: [{ card: card('Gemstone Caverns'), counters: { luck: 1 } }],
    },
  ),
  entry(
    'Gemstone Caverns',
    'no-luck',
    'Gemstone Caverns: colorless without a luck counter',
    [2],
    ['Try to cast PR11 Lab Shock with Gemstone Caverns as your only land.'],
    'Without a luck counter the Caverns add only {C}, so Lab Shock cannot be cast.',
    { p1Hand: [SHOCK], p1Field: [card('Gemstone Caverns')] },
  ),

  // PR11.18 Teferi's Protection
  entry(
    "Teferi's Protection",
    'protection',
    "Teferi's Protection: protection from everything and phasing",
    [1, 2],
    ["Cast Teferi's Protection; P2 then tries to cast PR11 Lab Shock at you."],
    'Your permanents phase out, you cannot be targeted, your life stays 40, and the spell is exiled.',
    {
      p1Hand: [card("Teferi's Protection")],
      p1Field: [BEAR],
      p1Lands: lands('Plains', 3),
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS('P1'),
    },
  ),
  entry(
    "Teferi's Protection",
    'phase-in',
    "Teferi's Protection: permanents phase back in on your turn",
    [1],
    ["Cast Teferi's Protection, then pass through to your next turn."],
    'Your permanents phase in during your untap step and the protection ends.',
    {
      p1Hand: [card("Teferi's Protection")],
      p1Field: [BEAR],
      p1Lands: lands('Plains', 3),
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11.19 Mana Vault
  entry(
    'Mana Vault',
    'mana',
    'Mana Vault: tap for three colorless',
    [4],
    ['Tap Mana Vault for {C}{C}{C} and cast PR11 Lab Relic.'],
    'Mana Vault pays the whole {3} cost; Lab Relic enters the battlefield.',
    { p1Hand: [RELIC], p1Field: [card('Mana Vault')] },
  ),
  entry(
    'Mana Vault',
    'pay-untap',
    'Mana Vault: pay {4} in your upkeep to untap it',
    [1, 2, 3],
    ['With Mana Vault tapped, pass to your upkeep and pay {4}.'],
    'Mana Vault stays tapped through your untap step, untaps when you pay, and deals no damage.',
    {
      p1Hand: [],
      p1Field: [{ card: card('Mana Vault'), tapped: true }],
      p1Lands: lands('Forest', 4),
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),
  entry(
    'Mana Vault',
    'damage',
    'Mana Vault: a tapped Vault deals 1 damage in your draw step',
    [1, 2, 3],
    ['With Mana Vault tapped, decline to pay in your upkeep.'],
    'Mana Vault stays tapped and deals 1 damage to you at the beginning of your draw step.',
    {
      p1Hand: [],
      p1Field: [{ card: card('Mana Vault'), tapped: true }],
      p1Lands: lands('Forest', 4),
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11.20 The One Ring
  entry(
    'The One Ring',
    'cast',
    'The One Ring: protection from everything when cast',
    [2],
    ['Cast The One Ring; P2 then tries to cast PR11 Lab Shock at you.'],
    'You gain protection from everything, so P2 cannot target you and your life stays 40.',
    {
      p1Hand: [card('The One Ring')],
      p1Lands: lands('Plains', 4),
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS('P1'),
    },
  ),
  entry(
    'The One Ring',
    'draw',
    'The One Ring: add a burden counter and draw',
    [4],
    ['Activate The One Ring’s {T} ability.'],
    'The Ring gets a burden counter and you draw one card.',
    { p1Hand: [], p1Field: [card('The One Ring')] },
  ),
  entry(
    'The One Ring',
    'upkeep',
    'The One Ring: lose life for each burden counter',
    [3],
    ['With two burden counters on the Ring, pass to your upkeep.'],
    'You lose 2 life at the beginning of your upkeep.',
    {
      p1Hand: [],
      p1Field: [{ card: card('The One Ring'), counters: { burden: 2 } }],
      prepared: THROUGH_YOUR_NEXT_TURN,
    },
  ),

  // PR11.22 Clever Concealment
  entry(
    'Clever Concealment',
    'phase-out',
    'Clever Concealment: phase out chosen nonland permanents',
    [2],
    ['Cast Clever Concealment targeting PR11 Lab Bear and PR11 Lab Relic.'],
    'Both targets phase out; your lands stay.',
    {
      p1Hand: [card('Clever Concealment')],
      p1Field: [BEAR, RELIC],
      p1Lands: lands('Plains', 4),
    },
  ),
  entry(
    'Clever Concealment',
    'convoke',
    'Clever Concealment: convoke with your creatures',
    [1, 2],
    ['Cast Clever Concealment with two Plains, tapping two creatures for the rest.'],
    'Convoke pays two of the four mana and the spell resolves.',
    {
      p1Hand: [card('Clever Concealment')],
      p1Field: [BEAR, RED_BEAR],
      p1Lands: lands('Plains', 2),
    },
  ),

  // PR11.24 Shanna, Sisay's Legacy
  entry(
    "Shanna, Sisay's Legacy",
    'power',
    'Shanna: +1/+1 for each creature you control',
    [2],
    ['Look at Shanna with two other creatures on your side.'],
    'Shanna is 3/3: three creatures, including herself.',
    { p1Hand: [], p1Field: [card("Shanna, Sisay's Legacy"), BEAR, RED_BEAR] },
  ),
  entry(
    "Shanna, Sisay's Legacy",
    'ability-target',
    "Shanna: opponents' abilities can't target her",
    [1],
    ['Pass priority; P2 activates PR11 Lab Pinger.'],
    'Shanna is not offered as a target for P2’s ability; Lab Bear can be.',
    {
      p1Hand: [],
      p1Field: [card("Shanna, Sisay's Legacy"), BEAR],
      p2Field: [PINGER],
      opponent: { seat: 'P2', activate: 'PR11 Lab Pinger', targets: ["Shanna, Sisay's Legacy"] },
    },
  ),
  entry(
    "Shanna, Sisay's Legacy",
    'spell-target',
    "Shanna: opponents' spells can still target her",
    [1],
    ['Pass priority; P2 casts PR11 Lab Shock at Shanna.'],
    'A spell may target Shanna; she is 2/2 with Lab Bear and dies to the 2 damage.',
    {
      p1Hand: [],
      p1Field: [card("Shanna, Sisay's Legacy"), BEAR],
      p2Hand: [SHOCK],
      p2Lands: ['Mountain'],
      opponent: P2_SHOCKS("Shanna, Sisay's Legacy"),
    },
  ),

  // PR11.25 Basri's Lieutenant
  entry(
    "Basri's Lieutenant",
    'enters',
    "Basri's Lieutenant: put a +1/+1 counter on a creature",
    [2],
    ["Cast Basri's Lieutenant and target PR11 Lab Bear with its trigger."],
    'Lab Bear gets a +1/+1 counter.',
    {
      p1Hand: [card("Basri's Lieutenant")],
      p1Field: [BEAR],
      p1Lands: lands('Plains', 4),
    },
  ),
  entry(
    "Basri's Lieutenant",
    'multicolored',
    "Basri's Lieutenant: protection from multicolored",
    [1],
    ['Pass priority; P2 tries to cast PR11 Lab Gold Bolt at the Lieutenant.'],
    'The Lieutenant cannot be targeted by the multicolored spell, so P2 must choose another target.',
    {
      p1Hand: [],
      p1Field: [card("Basri's Lieutenant")],
      p2Hand: [GOLD_BOLT],
      p2Lands: ['Mountain', 'Forest'],
      opponent: { seat: 'P2', cast: GOLD_BOLT, targets: ["Basri's Lieutenant"] },
    },
  ),
  entry(
    "Basri's Lieutenant",
    'dies',
    "Basri's Lieutenant: a creature with a +1/+1 counter dies and makes a Knight",
    [3],
    ['Cast PR11 Lab Fire Bolt at your own PR11 Lab Red Bear, which has a +1/+1 counter.'],
    'The Bear dies with a +1/+1 counter on it and you create a 2/2 white Knight token with vigilance.',
    {
      p1Hand: [FIRE_BOLT],
      p1Field: [card("Basri's Lieutenant"), { card: RED_BEAR, counters: { '+1/+1': 1 } }],
      p1Lands: lands('Mountain', 2),
    },
  ),

  // PR11.28 Negative Zone Portal
  entry(
    'Negative Zone Portal',
    'creature',
    'Negative Zone Portal: exile a creature card and draw',
    [1],
    ['Activate the Portal targeting PR11 Lab Bear in P2’s graveyard.'],
    'Lab Bear is exiled and, as a creature card, you draw a card.',
    {
      p1Hand: [],
      p1Field: [card('Negative Zone Portal')],
      p1Lands: lands('Forest', 2),
      p2Graveyard: [BEAR],
    },
  ),
  entry(
    'Negative Zone Portal',
    'noncreature',
    'Negative Zone Portal: a noncreature card draws nothing',
    [1],
    ['Activate the Portal targeting PR11 Lab Shock in P2’s graveyard.'],
    'Lab Shock is exiled and you draw no card.',
    {
      p1Hand: [],
      p1Field: [card('Negative Zone Portal')],
      p1Lands: lands('Forest', 2),
      p2Graveyard: [SHOCK],
    },
  ),

  // PR11.29 Spirit Mantle
  entry(
    'Spirit Mantle',
    'cast',
    'Spirit Mantle: +1/+1 and protection from creatures',
    [1, 2],
    ['Cast Spirit Mantle on PR11 Lab Bear.'],
    'Lab Bear becomes 3/3 with protection from creatures.',
    { p1Hand: [card('Spirit Mantle')], p1Field: [BEAR], p1Lands: lands('Plains', 2) },
  ),
  entry(
    'Spirit Mantle',
    'ability-target',
    'Spirit Mantle: a creature’s ability cannot target the enchanted creature',
    [2],
    ['Pass priority; P2 activates PR11 Lab Pinger.'],
    'The enchanted Lab Bear is not offered as a target for the creature’s ability.',
    {
      p1Hand: [],
      p1Field: [BEAR, { card: card('Spirit Mantle'), attachedTo: 'PR11 Lab Bear' }],
      p2Field: [PINGER],
      opponent: { seat: 'P2', activate: 'PR11 Lab Pinger', targets: ['PR11 Lab Bear'] },
    },
  ),

  // PR11.30 Unquestioned Authority
  entry(
    'Unquestioned Authority',
    'cast',
    'Unquestioned Authority: draw a card and grant protection from creatures',
    [1, 2, 3],
    ['Cast Unquestioned Authority on PR11 Lab Bear.'],
    'You draw a card and Lab Bear has protection from creatures.',
    {
      p1Hand: [card('Unquestioned Authority')],
      p1Field: [BEAR],
      p1Lands: lands('Plains', 3),
    },
  ),
];

export const PR11_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

/** The scripted opponent: takes its planned action once, then passes. */
function opponentProvider(plan: OpponentPlan, engine: () => Engine) {
  let done = false;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const pass = request.legalActions.find((action) => action.type === 'pass');
      // It acts only with an empty stack: never in response to the viewer's spell.
      const action =
        done || engine().getState().stack.length > 0
          ? undefined
          : request.legalActions.find((candidate) =>
              plan.cast !== undefined
                ? candidate.type === 'castSpell' && candidate.description.includes(plan.cast.name)
                : candidate.type === 'activateAbility' &&
                  candidate.description.includes(plan.activate ?? '\0'),
            );
      if (action === undefined)
        return { requestId: request.requestId, actionId: (pass ?? request.legalActions[0]!).id };
      done = true;
      const battlefield = engine().getState().battlefield;
      return {
        requestId: request.requestId,
        actionId: action.id,
        targets: (action.targets ?? []).map((slot) => {
          const want = plan.targets[slot.slot] ?? '';
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
    if (item.counters === undefined && item.tapped === undefined && item.attachedTo === undefined)
      plain.push(item.card.name);
    else
      groups.push({
        playerId,
        cardNames: [item.card.name],
        ...(item.counters !== undefined ? { counters: item.counters } : {}),
        ...(item.tapped !== undefined ? { tapped: item.tapped } : {}),
        ...(item.attachedTo !== undefined
          ? { attachedToCard: { playerId, cardName: item.attachedTo } }
          : {}),
      });
  }
  return plain.length > 0 ? [{ playerId, cardNames: plain }, ...groups] : groups;
}

/** Source-pinned prepared Card Test Lab scenarios for the PR11 protection and lifecycle cards. */
export function pr11Scenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown PR11 scenario ${id}`);
  const source = pin(def.cardName);
  const p1Field = (def.p1Field ?? []).map(placed);
  const p2Field = (def.p2Field ?? []).map(placed);
  const p1Lands = def.p1Lands ?? [];
  const p2Lands = def.p2Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'PR11 support land'));
  for (const support of [...SUPPORT_CARDS, source.card]) cardNamed.set(support.name, support);
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR11 filler land'),
    );

  const p1Hand = [...def.p1Hand, TRINKET];
  const p1Cards = [
    ...p1Hand,
    ...p1Field.map((item) => item.card),
    ...(def.p1Graveyard ?? []),
    ...named(p1Lands),
  ];
  const p2Cards = [
    ...(def.p2Hand ?? []),
    ...p2Field.map((item) => item.card),
    ...(def.p2Graveyard ?? []),
    ...named(p2Lands),
  ];

  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr11-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [...p1Cards, ...filler(def.p1Library ?? 24)]
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
    ...(def.p1Graveyard?.length || def.p2Graveyard?.length
      ? {
          graveyard: [
            ...(def.p1Graveyard?.length
              ? [{ playerId: 'P1' as const, cardNames: def.p1Graveyard.map((item) => item.name) }]
              : []),
            ...(def.p2Graveyard?.length
              ? [{ playerId: 'P2' as const, cardNames: def.p2Graveyard.map((item) => item.name) }]
              : []),
          ],
        }
      : {}),
    ...(def.lifeTotals ? { lifeTotals: def.lifeTotals } : {}),
    ...def.prepared,
  };

  const seed = `pr11-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  return {
    metadata: {
      id,
      version: 1,
      title: def.title,
      instructions: def.instructions,
      expectedOutcome: def.expectedOutcome,
      oracleSha256: source.sha256,
      clauseIds: def.lines.map((line) => `pr11-${slug(def.cardName)}-clause-${line}`),
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
