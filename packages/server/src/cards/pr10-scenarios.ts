import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { EnginePlayerConfig, PreparedScenarioSpec } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';
import { supportCard } from './pr09-scenario-fixtures';

type Pin = { sha256: string; card: OracleCard };

const pins = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/engine/tests/fixtures/coverage-pr10-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;

for (const entry of pins)
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`PR10 Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR10 Oracle pin ${name}`);
  return found;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Sorcery'];

/** A source-free Card Test Lab support card; the Oracle text is interpreted by the real engine. */
function lab(
  name: string,
  typeLine: string,
  manaCost: string,
  oracleText: string,
  colors: OracleCard['colors'],
  stats: [string, string] | null = null,
): OracleCard {
  const base = supportCard('Forest', 'PR10 support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pr10-${slug(name)}`;
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
    keywords: /^Flash(\n|$)/.test(oracleText) ? ['Flash'] : [],
    isBasicLand: false,
  };
}

export const SHOCK = lab(
  'PR10 Lab Shock',
  'Instant',
  '{R}',
  'PR10 Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const ZAP = lab(
  'PR10 Lab Zap',
  'Instant',
  '{R}',
  'PR10 Lab Zap deals 1 damage to any target.',
  ['R'],
);
export const TWIN = lab(
  'PR10 Lab Twin Spell',
  'Instant',
  '{R}',
  'Target creature gets +2/+2 until end of turn.\nTarget player draws a card.',
  ['R'],
);
export const BEAR = lab('PR10 Lab Bear', 'Creature — Bear', '{1}{G}', 'Flash', ['G'], ['2', '2']);
export const RED_BEAR = lab('PR10 Lab Red Bear', 'Creature — Bear', '{R}', '', ['R'], ['2', '2']);
export const BRUTE = lab('PR10 Lab Brute', 'Creature — Giant', '{2}{R}', '', ['R'], ['4', '4']);
export const COMMANDER = lab(
  'PR10 Lab Commander',
  'Legendary Creature — Human',
  '{1}{R}',
  '',
  ['R'],
  ['2', '2'],
);

export const CINDER = lab(
  'PR10 Lab Cinder',
  'Instant',
  '{1}{R}',
  'PR10 Lab Cinder deals 2 damage to any target.',
  ['R'],
);
export const PINGER = lab(
  'PR10 Lab Pinger',
  'Creature — Goblin',
  '{1}{R}',
  '{T}: This creature deals 1 damage to any target.',
  ['R'],
  ['1', '1'],
);
export const WIZARD = lab(
  'PR10 Lab Wizard',
  'Creature — Human Wizard',
  '{1}{U}',
  '',
  ['U'],
  ['1', '1'],
);
const SPARK = 'When this creature enters, this creature deals 1 damage to any target.';
export const SPARKER = lab('PR10 Lab Sparker', 'Creature — Imp', '{1}', SPARK, [], ['1', '1']);
export const LANDFALL_SPARKER = lab(
  'PR10 Lab Landfall Sparker',
  'Creature — Imp',
  '{1}',
  'Whenever a land you control enters, this creature deals 1 damage to any target.',
  [],
  ['1', '1'],
);
/** A basic land in P1's hand, for scenarios that need a land entering the battlefield. */
export const SWAMP = supportCard('Swamp', 'PR10 support land');
export const FLASH_SPARKER = lab(
  'PR10 Lab Flash Sparker',
  'Creature — Imp',
  '{1}',
  `Flash\n${SPARK}`,
  [],
  ['1', '1'],
);
export const BLOODLETTER = lab(
  'PR10 Lab Bloodletter',
  'Creature — Vampire',
  '{1}',
  'Pay 2 life: Draw a card.',
  [],
  ['1', '1'],
);
export const BLOOD_PINGER = lab(
  'PR10 Lab Blood Pinger',
  'Creature — Vampire',
  '{1}',
  'Pay 1 life: This creature deals 1 damage to any target.',
  [],
  ['1', '1'],
);
export const SCHOLAR = lab(
  'PR10 Lab Scholar',
  'Creature — Human',
  '{1}',
  '{T}: Draw a card.',
  [],
  ['1', '1'],
);

const GAIN = 'When this creature enters, you gain 3 life.';
export const ELF_HEALER = lab(
  'PR10 Lab Elf Healer',
  'Creature — Elf Druid',
  '{1}',
  GAIN,
  [],
  ['1', '1'],
);
export const BEAR_HEALER = lab(
  'PR10 Lab Bear Healer',
  'Creature — Bear',
  '{1}',
  GAIN,
  [],
  ['1', '1'],
);
export const LEGEND_HEALER = lab(
  'PR10 Lab Legend Healer',
  'Legendary Creature — Human',
  '{1}',
  GAIN,
  [],
  ['1', '1'],
);
export const COMMONER_HEALER = lab(
  'PR10 Lab Commoner Healer',
  'Creature — Human',
  '{1}',
  GAIN,
  [],
  ['1', '1'],
);

export const TRINKET = lab('PR10 Lab Trinket', 'Artifact', '{1}', '', []);

export const REANIMATE = lab(
  'PR10 Lab Reanimate',
  'Sorcery',
  '{1}{B}',
  'Return target creature card from your graveyard to the battlefield.',
  ['B'],
);

const SUPPORT_CARDS = [SHOCK, ZAP, TWIN, BEAR, RED_BEAR, BRUTE, COMMANDER, CINDER];

/**
 * What the scripted opponent P2 does the first time it holds priority: cast `spell`, or activate
 * the ability of its permanent named `activate`. A target choice is a seat id, or the name of a
 * permanent or stack object; a slot with no matching choice falls back to its first legal option.
 */
interface OpponentCast {
  spell?: OracleCard;
  activate?: string;
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
  p1Field?: OracleCard[];
  p1Graveyard?: OracleCard[];
  /** Number of basic lands P1 controls, by name. */
  p1Lands?: string[];
  p1Commander?: boolean;
  opponent?: OpponentCast;
  /** Extra permanents controlled by P3 (for example, a creature for a two-target spell). */
  p3Field?: OracleCard[];
  /** Permanents controlled by P2 (the scripted opponent) besides its two lands. */
  p2Field?: OracleCard[];
  p4Field?: OracleCard[];
  /** Basic lands P2 controls when it is the scripted opponent; defaults to a Mountain and a Forest. */
  p2Lands?: string[];
  /** Cards placed on top of P1's library, first card on top. */
  p1Library?: OracleCard[];
  /** Arranged state for P1's named battlefield cards. */
  fieldOptions?: Record<string, { tapped?: boolean; counters?: Record<string, number> }>;
  prepared?: Partial<PreparedScenarioSpec>;
}

const entry = (
  slugPart: string,
  cardName: string,
  kind: string,
  title: string,
  lines: number[],
  instructions: string[],
  expectedOutcome: string,
  rest: Omit<Def, 'id' | 'cardName' | 'title' | 'lines' | 'instructions' | 'expectedOutcome'>,
): Def => ({
  id: `pr10-${slugPart}-viewer-${kind}`,
  cardName,
  title,
  lines,
  instructions,
  expectedOutcome,
  ...rest,
});

const SHOCK_P3: OpponentCast = { spell: SHOCK, targets: ['P3'] };
const mountains = (count: number) => Array.from({ length: count }, () => 'Mountain');
const CAST_ON_SHOCK = (card: string) =>
  `Pass priority so P2 casts PR10 Lab Shock at P3, then cast ${card} targeting that spell.`;

const DEFS: Def[] = [
  // PR10.01 Deflecting Swat
  entry(
    'deflecting-swat',
    'Deflecting Swat',
    'positive',
    'Deflecting Swat: redirect an opponent spell to a new target',
    [2],
    [CAST_ON_SHOCK('Deflecting Swat'), 'Choose P4 as the new target when asked.'],
    'The same Lab Shock is retargeted from P3 to P4, so P4 takes 2 damage and P3 takes none.',
    { p1Hand: [pin('Deflecting Swat').card], p1Lands: mountains(3), opponent: SHOCK_P3 },
  ),
  entry(
    'deflecting-swat',
    'Deflecting Swat',
    'negative',
    'Deflecting Swat: keep the original target',
    [2],
    [CAST_ON_SHOCK('Deflecting Swat'), 'Decline to choose new targets.'],
    'Lab Shock keeps its original target, so P3 takes 2 damage and P4 takes none.',
    { p1Hand: [pin('Deflecting Swat').card], p1Lands: mountains(3), opponent: SHOCK_P3 },
  ),
  entry(
    'deflecting-swat',
    'Deflecting Swat',
    'commander',
    'Deflecting Swat: cast for free while controlling a commander',
    [1],
    [CAST_ON_SHOCK('Deflecting Swat for free'), 'Choose P4 as the new target.'],
    'With a commander and no lands, Swat is cast free through the normal cast path and redirects the spell.',
    { p1Hand: [pin('Deflecting Swat').card], p1Commander: true, opponent: SHOCK_P3 },
  ),
  entry(
    'deflecting-swat',
    'Deflecting Swat',
    'no-commander',
    'Deflecting Swat: no free cast without a commander',
    [1],
    [
      'Pass priority so P2 casts PR10 Lab Shock at P3.',
      'With one land and no commander, PR10 Lab Zap is castable but Deflecting Swat is not.',
    ],
    'Swat is not offered because there is not enough mana and no commander to make it free.',
    {
      p1Hand: [pin('Deflecting Swat').card, ZAP],
      p1Lands: mountains(1),
      opponent: SHOCK_P3,
    },
  ),

  // PR10.11 Bolt Bend
  entry(
    'bolt-bend',
    'Bolt Bend',
    'positive',
    'Bolt Bend: change the single target of an opponent spell',
    [2],
    [CAST_ON_SHOCK('Bolt Bend'), 'Choose the new target when asked.'],
    'Lab Shock is aimed at a different legal target, so P3 takes no damage.',
    { p1Hand: [pin('Bolt Bend').card], p1Lands: mountains(4), opponent: SHOCK_P3 },
  ),
  entry(
    'bolt-bend',
    'Bolt Bend',
    'negative',
    'Bolt Bend: a spell with two targets is not a legal target',
    [2],
    [
      'Pass priority so P2 casts a spell with two targets.',
      'Bolt Bend has no legal target, while PR10 Lab Zap can still be cast.',
    ],
    'Bolt Bend is not offered because the only spell on the stack has two targets.',
    {
      p1Hand: [pin('Bolt Bend').card, ZAP],
      p1Lands: mountains(4),
      opponent: { spell: TWIN, targets: ['', 'P3'] },
      p3Field: [BEAR],
    },
  ),
  entry(
    'bolt-bend',
    'Bolt Bend',
    'reduction',
    'Bolt Bend: costs three less with a creature of power 4 or greater',
    [1],
    [CAST_ON_SHOCK('Bolt Bend for {R}')],
    'With a 4-power creature, Bolt Bend is cast for a single red mana.',
    {
      p1Hand: [pin('Bolt Bend').card],
      p1Field: [BRUTE],
      p1Lands: mountains(1),
      opponent: SHOCK_P3,
    },
  ),
  entry(
    'bolt-bend',
    'Bolt Bend',
    'no-reduction',
    'Bolt Bend: no reduction without a creature of power 4 or greater',
    [1],
    [
      'Pass priority so P2 casts PR10 Lab Shock at P3.',
      'Bolt Bend cannot be cast for one mana, while PR10 Lab Zap can.',
    ],
    'With only a 2-power creature and one land, Bolt Bend is not offered.',
    {
      p1Hand: [pin('Bolt Bend').card, ZAP],
      p1Field: [RED_BEAR],
      p1Lands: mountains(1),
      opponent: SHOCK_P3,
    },
  ),

  // PR10.06 Reverberate
  entry(
    'reverberate',
    'Reverberate',
    'positive',
    'Reverberate: copy an instant with a new target',
    [1],
    [CAST_ON_SHOCK('Reverberate'), 'Choose P4 as the copy’s new target.'],
    'The original Lab Shock still hits P3 and the copy hits P4.',
    { p1Hand: [pin('Reverberate').card], p1Lands: mountains(2), opponent: SHOCK_P3 },
  ),
  entry(
    'reverberate',
    'Reverberate',
    'negative',
    'Reverberate: a creature spell cannot be copied',
    [1],
    [
      'Pass priority so P2 casts a creature spell.',
      'Reverberate has no legal target, while PR10 Lab Zap can still be cast.',
    ],
    'Reverberate is not offered because only instant and sorcery spells can be copied.',
    {
      p1Hand: [pin('Reverberate').card, ZAP],
      p1Lands: mountains(2),
      opponent: { spell: BEAR, targets: [] },
    },
  ),

  // PR10.14 Flare of Duplication
  entry(
    'flare-of-duplication',
    'Flare of Duplication',
    'positive',
    'Flare of Duplication: pay mana and copy an instant with a new target',
    [2],
    [CAST_ON_SHOCK('Flare of Duplication'), 'Choose P4 as the copy’s new target.'],
    'The original Lab Shock still hits P3 and the copy hits P4.',
    { p1Hand: [pin('Flare of Duplication').card], p1Lands: mountains(3), opponent: SHOCK_P3 },
  ),
  entry(
    'flare-of-duplication',
    'Flare of Duplication',
    'negative',
    'Flare of Duplication: a creature spell cannot be copied',
    [2],
    [
      'Pass priority so P2 casts a creature spell.',
      'Flare has no legal target, while PR10 Lab Zap can still be cast.',
    ],
    'Flare is not offered, by mana or by sacrifice, because only instant and sorcery spells can be copied.',
    {
      p1Hand: [pin('Flare of Duplication').card, ZAP],
      p1Field: [RED_BEAR],
      p1Lands: mountains(3),
      opponent: { spell: BEAR, targets: [] },
    },
  ),
  entry(
    'flare-of-duplication',
    'Flare of Duplication',
    'sacrifice',
    'Flare of Duplication: sacrifice a nontoken red creature instead of paying',
    [1],
    [
      CAST_ON_SHOCK('Flare of Duplication using the alternative cost'),
      'Sacrifice PR10 Lab Red Bear, then choose P4 as the copy’s new target.',
    ],
    'With no lands, the red creature is sacrificed and the copy of Lab Shock hits P4.',
    {
      p1Hand: [pin('Flare of Duplication').card],
      p1Field: [RED_BEAR],
      opponent: SHOCK_P3,
    },
  ),
  entry(
    'flare-of-duplication',
    'Flare of Duplication',
    'no-sacrifice',
    'Flare of Duplication: a nonred creature cannot pay the alternative cost',
    [1],
    [
      'Pass priority so P2 casts PR10 Lab Shock at P3.',
      'Flare cannot be cast with one land and a green creature, while PR10 Lab Zap can.',
    ],
    'A green creature does not pay the alternative cost, so Flare is not offered.',
    {
      p1Hand: [pin('Flare of Duplication').card, ZAP],
      p1Lands: mountains(1),
      p1Field: [BEAR],
      opponent: SHOCK_P3,
    },
  ),

  // PR10.12 Display of Power
  entry(
    'display-of-power',
    'Display of Power',
    'positive',
    'Display of Power: copy two spells, each with a new target',
    [2],
    [
      'Pass priority so P2 casts PR10 Lab Shock at P3, then cast PR10 Lab Zap at P2.',
      'Cast Display of Power targeting both spells and choose P4 as each copy’s new target.',
    ],
    'Both spells are copied; the copies of Lab Shock and Lab Zap both aim at P4.',
    {
      p1Hand: [pin('Display of Power').card, ZAP],
      p1Lands: mountains(4),
      opponent: SHOCK_P3,
    },
  ),
  entry(
    'display-of-power',
    'Display of Power',
    'negative',
    'Display of Power: cast choosing no spells',
    [2],
    ['Cast Display of Power with an empty stack and choose no targets.'],
    'Display of Power resolves and creates no copy.',
    { p1Hand: [pin('Display of Power').card], p1Lands: mountains(3) },
  ),
  entry(
    'display-of-power',
    'Display of Power',
    'cant-be-copied',
    'Display of Power: Reverberate creates no copy of it',
    [1],
    [
      'Cast Display of Power with no targets.',
      'Cast Reverberate targeting Display of Power and let both resolve.',
    ],
    'Reverberate resolves but creates no copy, because Display of Power cannot be copied.',
    {
      p1Hand: [pin('Display of Power').card, pin('Reverberate').card],
      p1Lands: mountains(5),
    },
  ),

  // PR10.19 Galvanic Iteration
  entry(
    'galvanic-iteration',
    'Galvanic Iteration',
    'positive',
    'Galvanic Iteration: copy the next instant with a new target',
    [1],
    [
      'Cast Galvanic Iteration and let it resolve.',
      'Cast PR10 Lab Shock at P2, then choose P3 as the copy’s new target.',
    ],
    'Lab Shock is copied on cast; the original hits P2 and the copy hits P3.',
    {
      p1Hand: [pin('Galvanic Iteration').card, SHOCK],
      p1Lands: ['Island', 'Mountain', 'Mountain'],
    },
  ),
  entry(
    'galvanic-iteration',
    'Galvanic Iteration',
    'negative',
    'Galvanic Iteration: a creature spell is not copied',
    [1],
    [
      'Cast Galvanic Iteration and let it resolve.',
      'Cast PR10 Lab Bear; it is not an instant or sorcery.',
    ],
    'The creature spell is not copied and Galvanic Iteration’s effect remains for the next instant.',
    {
      p1Hand: [pin('Galvanic Iteration').card, BEAR],
      p1Lands: ['Island', 'Mountain', 'Forest', 'Forest'],
    },
  ),
  entry(
    'galvanic-iteration',
    'Galvanic Iteration',
    'flashback',
    'Galvanic Iteration: cast from the graveyard with flashback',
    [2],
    ['Cast Galvanic Iteration from the graveyard with flashback.'],
    'Galvanic Iteration is cast for its flashback cost, resolves, and is exiled.',
    {
      p1Hand: [],
      p1Graveyard: [pin('Galvanic Iteration').card],
      p1Lands: ['Island', 'Mountain', 'Mountain'],
    },
  ),

  // PR10.26 Cosmic Crucible
  entry(
    'cosmic-crucible',
    'Cosmic Crucible',
    'mana',
    'Cosmic Crucible: add four mana at the beginning of your first main phase',
    [1],
    [
      'Pass priority through the other players’ turns; at the start of your next first main phase Crucible adds four mana.',
    ],
    'Cosmic Crucible adds four mana in any combination of colors to your pool.',
    {
      p1Hand: [],
      p1Field: [pin('Cosmic Crucible').card],
      prepared: { continueThroughPrecombatMains: 4 },
    },
  ),
  entry(
    'cosmic-crucible',
    'Cosmic Crucible',
    'copy',
    'Cosmic Crucible: copy a noncreature spell with a new target',
    [2],
    ['Cast PR10 Lab Shock at P2, accept the copy, and choose P3 as the copy’s new target.'],
    'Lab Shock is copied; the original hits P2 and the copy hits P3.',
    {
      p1Hand: [SHOCK],
      p1Field: [pin('Cosmic Crucible').card],
      p1Lands: mountains(1),
    },
  ),
  entry(
    'cosmic-crucible',
    'Cosmic Crucible',
    'once-each-turn',
    'Cosmic Crucible: only the first noncreature spell each turn',
    [2],
    ['Cast PR10 Lab Shock and copy it, then cast PR10 Lab Zap; Crucible does not trigger again.'],
    'Only the first spell is copied; the second noncreature spell is not.',
    {
      p1Hand: [SHOCK, ZAP],
      p1Field: [pin('Cosmic Crucible').card],
      p1Lands: mountains(2),
    },
  ),
  entry(
    'cosmic-crucible',
    'Cosmic Crucible',
    'negative',
    'Cosmic Crucible: a creature spell is not copied',
    [2],
    ['Cast PR10 Lab Red Bear; Crucible does not trigger for a creature spell.'],
    'The creature spell is not copied.',
    {
      p1Hand: [RED_BEAR],
      p1Field: [pin('Cosmic Crucible').card],
      p1Lands: mountains(1),
    },
  ),

  // PR10.08 Siren Stormtamer
  entry(
    'siren-stormtamer',
    'Siren Stormtamer',
    'counter-spell',
    'Siren Stormtamer: counter a spell that targets you',
    [2],
    [
      'Pass priority so P2 casts PR10 Lab Shock at you.',
      'Activate Siren Stormtamer ({U}, sacrifice it) targeting the spell.',
    ],
    'Siren is sacrificed and Lab Shock is countered, so you take no damage.',
    {
      p1Hand: [],
      p1Field: [pin('Siren Stormtamer').card],
      p1Lands: ['Island'],
      opponent: { spell: SHOCK, targets: ['P1'] },
    },
  ),
  entry(
    'siren-stormtamer',
    'Siren Stormtamer',
    'counter-ability',
    'Siren Stormtamer: counter an ability that targets your creature',
    [2],
    [
      'Pass priority so P2 activates PR10 Lab Pinger targeting PR10 Lab Bear.',
      'Activate Siren Stormtamer targeting that ability.',
    ],
    'The ability is countered, so your creature takes no damage.',
    {
      p1Hand: [],
      p1Field: [pin('Siren Stormtamer').card, BEAR],
      p1Lands: ['Island'],
      p2Field: [PINGER],
      opponent: { activate: PINGER.name, targets: [BEAR.name] },
    },
  ),
  entry(
    'siren-stormtamer',
    'Siren Stormtamer',
    'not-your-target',
    'Siren Stormtamer: a spell aimed elsewhere cannot be countered',
    [2],
    [
      'Pass priority so P2 casts PR10 Lab Shock at P3.',
      'Siren has no legal target, while PR10 Lab Zap can still be cast.',
    ],
    'Siren’s ability is not offered because the spell targets neither you nor your creature.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Siren Stormtamer').card],
      p1Lands: ['Island', 'Mountain'],
      opponent: SHOCK_P3,
    },
  ),

  // PR10.04 Mana Sculpt
  entry(
    'mana-sculpt',
    'Mana Sculpt',
    'wizard',
    'Mana Sculpt: counter a spell and add the mana spent with a Wizard',
    [1],
    [
      'Pass priority so P2 casts PR10 Lab Cinder ({1}{R}) at P3, then cast Mana Sculpt targeting it.',
      'Let everything resolve and move to your second main phase.',
    ],
    'Lab Cinder is countered; with a Wizard you add {C}{C} (the mana spent) at the beginning of your next main phase.',
    {
      p1Hand: [pin('Mana Sculpt').card],
      p1Field: [WIZARD],
      p1Lands: ['Island', 'Island', 'Island'],
      opponent: { spell: CINDER, targets: ['P3'] },
      prepared: { continueToPostcombatMain: true },
    },
  ),
  entry(
    'mana-sculpt',
    'Mana Sculpt',
    'no-wizard',
    'Mana Sculpt: counter a spell without a Wizard adds no mana',
    [1],
    [
      'Pass priority so P2 casts PR10 Lab Cinder at P3, then cast Mana Sculpt targeting it.',
      'Let everything resolve and move to your second main phase.',
    ],
    'Lab Cinder is countered and no mana is added, because you control no Wizard.',
    {
      p1Hand: [pin('Mana Sculpt').card],
      p1Lands: ['Island', 'Island', 'Island'],
      opponent: { spell: CINDER, targets: ['P3'] },
      prepared: { continueToPostcombatMain: true },
    },
  ),

  // PR10.21 Mister Fantastic
  entry(
    'mister-fantastic',
    'Mister Fantastic',
    'copy-twice',
    'Mister Fantastic: copy a triggered ability twice with new targets',
    [3],
    [
      'Play your Swamp; when PR10 Lab Landfall Sparker triggers, target P2 and then activate Mister Fantastic targeting that trigger.',
      'Choose P3 for the first copy and P4 for the second.',
    ],
    'The trigger and its two copies each deal 1 damage, to P2, P3 and P4.',
    {
      p1Hand: [SWAMP],
      p1Field: [pin('Mister Fantastic').card, LANDFALL_SPARKER],
      p1Lands: ['Mountain', 'Forest', 'Plains', 'Island'],
    },
  ),
  entry(
    'mister-fantastic',
    'Mister Fantastic',
    'opponent-trigger',
    'Mister Fantastic: an opponent’s triggered ability cannot be copied',
    [3],
    [
      'Pass priority so P2 flashes in PR10 Lab Flash Sparker and its enter trigger goes on the stack.',
      'Mister Fantastic has no legal target, while PR10 Lab Zap can still be cast.',
    ],
    'Mister Fantastic’s ability is not offered because the trigger is controlled by an opponent.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Mister Fantastic').card],
      p1Lands: ['Mountain', 'Forest', 'Plains', 'Island'],
      opponent: { spell: FLASH_SPARKER, targets: ['P3'] },
    },
  ),
  entry(
    'mister-fantastic',
    'Mister Fantastic',
    'combat-draw',
    'Mister Fantastic: draw at the beginning of combat after a noncreature spell',
    [2],
    ['Cast PR10 Lab Zap at P2, then move to combat.'],
    'At the beginning of combat Mister Fantastic’s trigger draws you a card.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Mister Fantastic').card],
      p1Lands: ['Mountain'],
      prepared: { continueThroughCombat: true },
    },
  ),
  entry(
    'mister-fantastic',
    'Mister Fantastic',
    'combat-no-draw',
    'Mister Fantastic: no draw without a noncreature spell this turn',
    [2],
    ['Cast nothing and move to combat.'],
    'Mister Fantastic does not trigger, so you draw nothing.',
    {
      p1Hand: [],
      p1Field: [pin('Mister Fantastic').card],
      prepared: { continueThroughCombat: true },
    },
  ),

  // PR10.10 Verrak, Warped Sengir
  entry(
    'verrak-warped-sengir',
    'Verrak, Warped Sengir',
    'pay-again',
    'Verrak: pay the life again to copy the ability',
    [2],
    ['Activate PR10 Lab Bloodletter (pay 2 life), then pay 2 life again when Verrak triggers.'],
    'The ability is copied: you pay 4 life in total and draw two cards.',
    { p1Hand: [], p1Field: [pin('Verrak, Warped Sengir').card, BLOODLETTER] },
  ),
  entry(
    'verrak-warped-sengir',
    'Verrak, Warped Sengir',
    'decline',
    'Verrak: decline to pay the life again',
    [2],
    ['Activate PR10 Lab Bloodletter (pay 2 life), then decline when Verrak triggers.'],
    'Nothing is copied: you pay 2 life and draw one card.',
    { p1Hand: [], p1Field: [pin('Verrak, Warped Sengir').card, BLOODLETTER] },
  ),
  entry(
    'verrak-warped-sengir',
    'Verrak, Warped Sengir',
    'new-target',
    'Verrak: the copy may choose a new target',
    [2],
    [
      'Activate PR10 Lab Blood Pinger targeting P2 (pay 1 life), then pay 1 life again when Verrak triggers.',
      'Choose P3 as the copy’s new target.',
    ],
    'The original ability hits P2 and the copy hits P3.',
    { p1Hand: [], p1Field: [pin('Verrak, Warped Sengir').card, BLOOD_PINGER] },
  ),
  entry(
    'verrak-warped-sengir',
    'Verrak, Warped Sengir',
    'no-life',
    'Verrak: an ability that costs no life does not trigger it',
    [2],
    ['Activate PR10 Lab Scholar, which costs no life.'],
    'Verrak does not trigger: you draw one card and are never asked to pay life.',
    { p1Hand: [], p1Field: [pin('Verrak, Warped Sengir').card, SCHOLAR] },
  ),

  // PR10.18 Roaming Throne
  entry(
    'roaming-throne',
    'Roaming Throne',
    'chosen-type-doubles',
    'Roaming Throne: another creature of the chosen type triggers twice',
    [2, 3, 4],
    [
      'Cast Roaming Throne and choose Elf as its creature type.',
      'Cast PR10 Lab Elf Healer, whose enter trigger gains you 3 life.',
    ],
    'Roaming Throne is also an Elf, and the Elf’s enter trigger fires twice, gaining 6 life.',
    {
      p1Hand: [pin('Roaming Throne').card, ELF_HEALER],
      p1Lands: mountains(5),
    },
  ),
  entry(
    'roaming-throne',
    'Roaming Throne',
    'other-type',
    'Roaming Throne: a creature of another type triggers once',
    [4],
    [
      'Cast Roaming Throne and choose Elf as its creature type.',
      'Cast PR10 Lab Bear Healer, which is not an Elf.',
    ],
    'The Bear’s enter trigger fires once, gaining 3 life.',
    {
      p1Hand: [pin('Roaming Throne').card, BEAR_HEALER, ELF_HEALER],
      p1Lands: mountains(5),
    },
  ),

  // PR10.24 Annie Joins Up
  entry(
    'annie-joins-up',
    'Annie Joins Up',
    'enter-damage',
    'Annie Joins Up: 5 damage to a creature an opponent controls',
    [1],
    ['Cast Annie Joins Up and target the creature P3 controls.'],
    'The enter trigger deals 5 damage, destroying PR10 Lab Brute; only an opponent’s creature can be targeted.',
    {
      p1Hand: [pin('Annie Joins Up').card],
      p1Field: [BEAR],
      p1Lands: ['Mountain', 'Forest', 'Plains', 'Island'],
      p3Field: [BRUTE],
    },
  ),
  entry(
    'annie-joins-up',
    'Annie Joins Up',
    'doubles-legendary',
    'Annie Joins Up: a legendary creature’s trigger fires twice',
    [2],
    ['Cast PR10 Lab Legend Healer, whose enter trigger gains you 3 life.'],
    'With Annie Joins Up in play, the legendary creature’s enter trigger fires twice, gaining 6 life.',
    {
      p1Hand: [LEGEND_HEALER],
      p1Field: [pin('Annie Joins Up').card],
      p1Lands: mountains(1),
    },
  ),
  entry(
    'annie-joins-up',
    'Annie Joins Up',
    'nonlegendary',
    'Annie Joins Up: a nonlegendary creature’s trigger fires once',
    [2],
    ['Cast PR10 Lab Commoner Healer, whose enter trigger gains you 3 life.'],
    'The nonlegendary creature’s enter trigger fires once, gaining 3 life.',
    {
      p1Hand: [COMMONER_HEALER],
      p1Field: [pin('Annie Joins Up').card],
      p1Lands: mountains(1),
    },
  ),

  // PR10.02 Atarka Monument
  entry(
    'atarka-monument',
    'Atarka Monument',
    'animate',
    'Atarka Monument: becomes a 4/4 red and green Dragon with flying',
    [2],
    ['Activate Atarka Monument’s second ability, paying {4}{R}{G}.'],
    'Until end of turn it is a 4/4 red and green Dragon artifact creature with flying.',
    {
      p1Hand: [],
      p1Field: [pin('Atarka Monument').card],
      p1Lands: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Forest'],
    },
  ),
  entry(
    'atarka-monument',
    'Atarka Monument',
    'insufficient-cost',
    'Atarka Monument: the animation needs {4}{R}{G}',
    [2],
    [
      'With four lands and the Monument’s own mana the animation cannot be paid, while PR10 Lab Zap can be cast.',
    ],
    'The animation is not offered, so Atarka Monument stays a noncreature artifact.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Atarka Monument').card],
      p1Lands: ['Mountain', 'Mountain', 'Mountain', 'Forest'],
    },
  ),
  entry(
    'atarka-monument',
    'Atarka Monument',
    'mana',
    'Atarka Monument: tap for red mana',
    [1],
    ['Cast PR10 Lab Zap at P2 with the red mana from Atarka Monument.'],
    'With only a Forest, Lab Zap is castable because the Monument taps for {R}.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Atarka Monument').card],
      p1Lands: ['Forest'],
    },
  ),

  // PR10.17 Sarkhan, the Dragonspeaker
  entry(
    'sarkhan-the-dragonspeaker',
    'Sarkhan, the Dragonspeaker',
    'plus-one',
    'Sarkhan: +1 makes him a legendary 4/4 red Dragon',
    [1],
    ['Activate Sarkhan’s +1.'],
    'Sarkhan gains a loyalty counter and is a 4/4 Dragon creature with flying, indestructible and haste until end of turn.',
    {
      p1Hand: [],
      p1Field: [pin('Sarkhan, the Dragonspeaker').card],
      fieldOptions: { 'Sarkhan, the Dragonspeaker': { counters: { loyalty: 4 } } },
    },
  ),
  entry(
    'sarkhan-the-dragonspeaker',
    'Sarkhan, the Dragonspeaker',
    'minus-three',
    'Sarkhan: −3 deals 4 damage to a creature',
    [2],
    ['Activate Sarkhan’s −3 targeting the creature P3 controls.'],
    'PR10 Lab Brute takes 4 damage and dies, and Sarkhan is left with one loyalty.',
    {
      p1Hand: [],
      p1Field: [pin('Sarkhan, the Dragonspeaker').card],
      p3Field: [BRUTE],
      fieldOptions: { 'Sarkhan, the Dragonspeaker': { counters: { loyalty: 4 } } },
    },
  ),
  entry(
    'sarkhan-the-dragonspeaker',
    'Sarkhan, the Dragonspeaker',
    'emblem',
    'Sarkhan: −6 creates an emblem',
    [3],
    ['Activate Sarkhan’s −6.'],
    'You get the emblem and Sarkhan is left with no loyalty.',
    {
      p1Hand: [],
      p1Field: [pin('Sarkhan, the Dragonspeaker').card],
      fieldOptions: { 'Sarkhan, the Dragonspeaker': { counters: { loyalty: 6 } } },
    },
  ),

  // PR10.20 Mirage Mirror
  entry(
    'mirage-mirror',
    'Mirage Mirror',
    'becomes-copy',
    'Mirage Mirror: becomes a copy of a creature until end of turn',
    [1],
    ['Activate Mirage Mirror ({2}) targeting the creature P3 controls.'],
    'Mirage Mirror becomes a copy of PR10 Lab Brute, a 4/4 creature you control.',
    {
      p1Hand: [],
      p1Field: [pin('Mirage Mirror').card],
      p1Lands: mountains(2),
      p3Field: [BRUTE],
    },
  ),
  entry(
    'mirage-mirror',
    'Mirage Mirror',
    'insufficient-cost',
    'Mirage Mirror: the ability needs {2}',
    [1],
    ['With one land the ability cannot be paid, while PR10 Lab Zap can be cast.'],
    'Mirage Mirror’s ability is not offered.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Mirage Mirror').card],
      p1Lands: mountains(1),
      p3Field: [BRUTE],
    },
  ),

  // PR10.07 Saheeli, Sublime Artificer
  entry(
    'saheeli-sublime-artificer',
    'Saheeli, Sublime Artificer',
    'servo',
    'Saheeli: a Servo for each noncreature spell',
    [1],
    ['Cast PR10 Lab Zap, a noncreature spell.'],
    'Saheeli’s trigger creates a 1/1 Servo artifact creature token.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Saheeli, Sublime Artificer').card],
      p1Lands: mountains(1),
      fieldOptions: { 'Saheeli, Sublime Artificer': { counters: { loyalty: 5 } } },
    },
  ),
  entry(
    'saheeli-sublime-artificer',
    'Saheeli, Sublime Artificer',
    'minus-two',
    'Saheeli: −2 turns an artifact into a copy of a creature',
    [2],
    ['Activate Saheeli’s −2 targeting PR10 Lab Trinket, then PR10 Lab Bear.'],
    'The Trinket becomes a copy of PR10 Lab Bear until end of turn and is still an artifact.',
    {
      p1Hand: [],
      p1Field: [pin('Saheeli, Sublime Artificer').card, TRINKET, BEAR],
      fieldOptions: { 'Saheeli, Sublime Artificer': { counters: { loyalty: 5 } } },
    },
  ),

  // PR10.17 Scute Swarm
  entry(
    'scute-swarm',
    'Scute Swarm',
    'insect',
    'Scute Swarm: landfall makes an Insect with fewer than six lands',
    [1],
    ['Play the Swamp from your hand with two other lands in play.'],
    'You control three lands, so landfall creates a 1/1 green Insect token.',
    { p1Hand: [SWAMP], p1Field: [pin('Scute Swarm').card], p1Lands: mountains(2) },
  ),
  entry(
    'scute-swarm',
    'Scute Swarm',
    'copy',
    'Scute Swarm: landfall copies it with six or more lands',
    [1],
    ['Play the Swamp from your hand with five other lands in play.'],
    'You control six lands, so landfall creates a token that is a copy of Scute Swarm.',
    { p1Hand: [SWAMP], p1Field: [pin('Scute Swarm').card], p1Lands: mountains(5) },
  ),

  // PR10.16 Council of Reeds
  entry(
    'council-of-reeds',
    'Council of Reeds',
    'legend-rule',
    'Council of Reeds: the legend rule does not apply to your creatures',
    [1],
    ['Cast a second PR10 Lab Commander while one is already in play.'],
    'Both legendary Commanders stay on the battlefield.',
    {
      p1Hand: [COMMANDER],
      p1Field: [pin('Council of Reeds').card, COMMANDER],
      p1Lands: mountains(2),
    },
  ),
  entry(
    'council-of-reeds',
    'Council of Reeds',
    'combat-copy',
    'Council of Reeds: a copy at the beginning of combat after a noncreature spell',
    [2],
    ['Cast PR10 Lab Zap at P2, then move to combat.'],
    'At the beginning of combat you create a token that is a copy of Council of Reeds.',
    {
      p1Hand: [ZAP],
      p1Field: [pin('Council of Reeds').card],
      p1Lands: mountains(1),
      prepared: { continueThroughCombat: true },
    },
  ),
  entry(
    'council-of-reeds',
    'Council of Reeds',
    'combat-no-copy',
    'Council of Reeds: no copy without a noncreature spell this turn',
    [2],
    ['Cast PR10 Lab Red Bear, a creature spell, then move to combat.'],
    'A creature spell does not count, so no token is created.',
    {
      p1Hand: [RED_BEAR],
      p1Field: [pin('Council of Reeds').card],
      p1Lands: mountains(1),
      prepared: { continueThroughCombat: true },
    },
  ),

  // PR10.18 Twilight Diviner
  entry(
    'twilight-diviner',
    'Twilight Diviner',
    'surveil',
    'Twilight Diviner: surveil 2 when it enters',
    [1],
    ['Cast Twilight Diviner and look at the top two cards of your library.'],
    'You surveil 2 as Twilight Diviner enters.',
    {
      p1Hand: [pin('Twilight Diviner').card],
      p1Lands: ['Swamp', 'Swamp', 'Swamp'],
      p1Library: [BEAR, RED_BEAR],
    },
  ),
  entry(
    'twilight-diviner',
    'Twilight Diviner',
    'from-graveyard',
    'Twilight Diviner: copy a creature that entered from a graveyard',
    [2],
    ['Cast PR10 Lab Reanimate to return PR10 Lab Bear from your graveyard.'],
    'The Bear entered from a graveyard, so you also create a token that is a copy of it.',
    {
      p1Hand: [REANIMATE],
      p1Field: [pin('Twilight Diviner').card],
      p1Graveyard: [BEAR],
      p1Lands: ['Swamp', 'Swamp'],
    },
  ),
  entry(
    'twilight-diviner',
    'Twilight Diviner',
    'from-hand',
    'Twilight Diviner: no copy for a creature cast from hand',
    [2],
    ['Cast PR10 Lab Bear from your hand.'],
    'The Bear did not enter from a graveyard, so no token is created.',
    {
      p1Hand: [BEAR],
      p1Field: [pin('Twilight Diviner').card],
      p1Lands: ['Forest', 'Forest'],
    },
  ),

  // PR10.07 Saheeli, Radiant Creator
  entry(
    'saheeli-radiant-creator',
    'Saheeli, Radiant Creator',
    'energy',
    'Saheeli, Radiant Creator: energy for an artifact spell',
    [1],
    ['Cast PR10 Lab Trinket, an artifact spell.'],
    'You get an energy counter.',
    { p1Hand: [TRINKET], p1Field: [pin('Saheeli, Radiant Creator').card], p1Lands: mountains(1) },
  ),
  entry(
    'saheeli-radiant-creator',
    'Saheeli, Radiant Creator',
    'combat-copy',
    'Saheeli, Radiant Creator: pay three energy for a hasty 5/5 copy',
    [2],
    ['Move to combat, pay {E}{E}{E}, and target PR10 Lab Brute.'],
    'A token copy of PR10 Lab Brute is created as a hasty 5/5 artifact creature, to be sacrificed at end step.',
    {
      p1Hand: [],
      p1Field: [pin('Saheeli, Radiant Creator').card, BRUTE],
      prepared: { continueThroughCombat: true, energy: [{ playerId: 'P1', amount: 3 }] },
    },
  ),
  entry(
    'saheeli-radiant-creator',
    'Saheeli, Radiant Creator',
    'not-enough-energy',
    'Saheeli, Radiant Creator: two energy is not enough',
    [2],
    ['Move to combat with only two energy.'],
    'There is nothing to pay, so no token is created.',
    {
      p1Hand: [],
      p1Field: [pin('Saheeli, Radiant Creator').card, BRUTE],
      prepared: { continueThroughCombat: true, energy: [{ playerId: 'P1', amount: 2 }] },
    },
  ),
  entry(
    'saheeli-radiant-creator',
    'Saheeli, Radiant Creator',
    'decline',
    'Saheeli, Radiant Creator: decline to pay',
    [2],
    ['Move to combat and decline to pay {E}{E}{E}.'],
    'You keep your energy and no token is created.',
    {
      p1Hand: [],
      p1Field: [pin('Saheeli, Radiant Creator').card, BRUTE],
      prepared: { continueThroughCombat: true, energy: [{ playerId: 'P1', amount: 3 }] },
    },
  ),

  // PR10.22 Mocking Doppelganger
  entry(
    'mocking-doppelganger',
    'Mocking Doppelganger',
    'copy',
    'Mocking Doppelganger: enter as a copy of an opponent’s creature',
    [1, 2],
    ['Cast Mocking Doppelganger and choose to copy the creature P3 controls.'],
    'It enters as a 4/4 PR10 Lab Brute that you control.',
    {
      p1Hand: [pin('Mocking Doppelganger').card],
      p1Lands: ['Island', 'Island', 'Island', 'Island'],
      p3Field: [BRUTE],
    },
  ),
  entry(
    'mocking-doppelganger',
    'Mocking Doppelganger',
    'decline',
    'Mocking Doppelganger: decline to copy',
    [2],
    ['Cast Mocking Doppelganger and decline to copy.'],
    'It enters as a 0/0 and dies, and nothing is goaded.',
    {
      p1Hand: [pin('Mocking Doppelganger').card],
      p1Lands: ['Island', 'Island', 'Island', 'Island'],
      p3Field: [BRUTE],
    },
  ),
];

export const PR10_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

function opponentProvider(opponent: OpponentCast, engine: () => Engine) {
  let acted = false;
  const resolve = (want: string | undefined, options: string[]): string => {
    if (want !== undefined && options.includes(want)) return want;
    const state = engine().getState();
    const byName = [...state.battlefield, ...state.stack].find(
      (item) =>
        options.includes(item.id) &&
        ('name' in item ? item.name === want : item.description.includes(want ?? '\0')),
    );
    return byName?.id ?? options[0]!;
  };
  return {
    decide(request: DecisionRequest): DecisionResponse {
      // A triggered ability of the opponent's own asks for its targets.
      const asked = request.legalActions.find((action) => action.type === 'chooseTargets');
      if (asked)
        return {
          requestId: request.requestId,
          actionId: asked.id,
          targets: (asked.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: resolve(opponent.targets[slot.slot], slot.options),
          })),
        };
      const act = acted
        ? undefined
        : request.legalActions.find((action) =>
            opponent.activate !== undefined
              ? action.type === 'activateAbility' &&
                action.description.startsWith(`${opponent.activate}:`)
              : action.type === 'castSpell' && action.description.includes(opponent.spell!.name),
          );
      const pass =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      if (!act) return { requestId: request.requestId, actionId: pass.id };
      acted = true;
      return {
        requestId: request.requestId,
        actionId: act.id,
        targets: (act.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: resolve(opponent.targets[slot.slot], slot.options),
        })),
      };
    },
  };
}

/** Source-pinned prepared Card Test Lab scenarios for the PR10 stack cards. */
export function pr10Scenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown PR10 scenario ${id}`);
  const source = pin(def.cardName);
  const lands = def.p1Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'PR10 support land'));
  for (const card of [...SUPPORT_CARDS, source.card]) cardNamed.set(card.name, card);
  const opponentSpell = def.opponent?.spell;
  for (const card of [
    ...def.p1Hand,
    ...(def.p1Field ?? []),
    ...(def.p1Graveyard ?? []),
    ...(def.p1Library ?? []),
    ...(def.p2Field ?? []),
    ...(def.p3Field ?? []),
    ...(def.p4Field ?? []),
    ...(opponentSpell ? [opponentSpell] : []),
  ])
    cardNamed.set(card.name, card);

  const p1Names = [
    ...def.p1Hand.map((card) => card.name),
    ...(def.p1Field ?? []).map((card) => card.name),
    ...(def.p1Graveyard ?? []).map((card) => card.name),
    ...(def.p1Library ?? []).map((card) => card.name),
    ...lands,
  ];
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR10 filler land'),
    );
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const commander = def.p1Commander ? COMMANDER : undefined;
  const p2Lands = def.opponent || def.p2Field ? (def.p2Lands ?? ['Mountain', 'Forest']) : [];
  const p2FieldNames = [...p2Lands, ...(def.p2Field ?? []).map((card) => card.name)];

  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr10-${seat}`,
    commanders: seat === 'P1' && commander ? [commander] : [],
    cards:
      seat === 'P1'
        ? [...named(p1Names), ...filler(24)]
        : seat === 'P2'
          ? [...(opponentSpell ? [opponentSpell] : []), ...named(p2FieldNames), ...filler(24)]
          : seat === 'P3'
            ? [...(def.p3Field ?? []), ...filler(24)]
            : [...(def.p4Field ?? []), ...filler(24)],
  }));

  const p2Hand = opponentSpell ? [opponentSpell.name] : [];
  const fieldOptions = def.fieldOptions ?? {};
  const optioned = (def.p1Field ?? []).filter((card) => fieldOptions[card.name] !== undefined);
  const prepared: PreparedScenarioSpec = {
    currentTurnPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    turnNumber: 4,
    hand: [
      { playerId: 'P1', cardNames: def.p1Hand.map((card) => card.name) },
      ...(p2Hand.length ? [{ playerId: 'P2' as const, cardNames: p2Hand }] : []),
    ],
    battlefield: [
      {
        playerId: 'P1',
        cardNames: [
          ...lands,
          ...(def.p1Field ?? [])
            .filter((card) => fieldOptions[card.name] === undefined)
            .map((card) => card.name),
          ...(commander ? [commander.name] : []),
        ],
      },
      ...optioned.map((card) => ({
        playerId: 'P1' as const,
        cardNames: [card.name],
        ...fieldOptions[card.name],
      })),
      ...(p2FieldNames.length ? [{ playerId: 'P2' as const, cardNames: p2FieldNames }] : []),
      ...(def.p3Field?.length
        ? [{ playerId: 'P3' as const, cardNames: def.p3Field.map((card) => card.name) }]
        : []),
      ...(def.p4Field?.length
        ? [{ playerId: 'P4' as const, cardNames: def.p4Field.map((card) => card.name) }]
        : []),
    ],
    ...(def.p1Graveyard?.length
      ? {
          graveyard: [
            { playerId: 'P1' as const, cardNames: def.p1Graveyard.map((card) => card.name) },
          ],
        }
      : {}),
    ...(def.p1Library?.length
      ? {
          libraryTop: [
            { playerId: 'P1' as const, cardNames: def.p1Library.map((card) => card.name) },
          ],
        }
      : {}),
    ...def.prepared,
  };

  const seed = `pr10-${id}-seed-1`;
  const engine: Engine = new Engine(
    { gameId, seed, players, turnCap: 12 },
    { preparedScenario: prepared },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: def.title,
      instructions: def.instructions,
      expectedOutcome: def.expectedOutcome,
      oracleSha256: source.sha256,
      clauseIds: def.lines.map((line) => `pr10-${slug(def.cardName)}-clause-${line}`),
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
        commanderNames: config.commanders.map((card) => card.name),
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    })),
    engine,
    ...(def.opponent
      ? { decisionProviderOverrides: { P2: opponentProvider(def.opponent, () => engine) } }
      : {}),
  };
}
