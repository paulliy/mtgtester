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
    keywords: oracleText === 'Flash' ? ['Flash'] : [],
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

const SUPPORT_CARDS = [SHOCK, ZAP, TWIN, BEAR, RED_BEAR, BRUTE, COMMANDER];

/** What the scripted opponent P2 casts the first time it holds priority. */
interface OpponentCast {
  spell: OracleCard;
  /** Preferred choice per target slot; a slot falls back to its first legal option. */
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
];

export const PR10_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

function opponentProvider(opponent: OpponentCast) {
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const cast = request.legalActions.find(
        (action) => action.type === 'castSpell' && action.description.includes(opponent.spell.name),
      );
      const pass =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      if (!cast) return { requestId: request.requestId, actionId: pass.id };
      return {
        requestId: request.requestId,
        actionId: cast.id,
        targets: (cast.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice: slot.options.includes(opponent.targets[slot.slot] ?? '')
            ? opponent.targets[slot.slot]!
            : slot.options[0]!,
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
  for (const card of [
    ...def.p1Hand,
    ...(def.p1Field ?? []),
    ...(def.p1Graveyard ?? []),
    ...(def.p3Field ?? []),
    ...(def.opponent ? [def.opponent.spell] : []),
  ])
    cardNamed.set(card.name, card);

  const p1Names = [
    ...def.p1Hand.map((card) => card.name),
    ...(def.p1Field ?? []).map((card) => card.name),
    ...(def.p1Graveyard ?? []).map((card) => card.name),
    ...lands,
  ];
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR10 filler land'),
    );
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const commander = def.p1Commander ? COMMANDER : undefined;

  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `pr10-${seat}`,
    commanders: seat === 'P1' && commander ? [commander] : [],
    cards:
      seat === 'P1'
        ? [...named(p1Names), ...filler(24)]
        : seat === 'P2'
          ? [
              ...(def.opponent ? [def.opponent.spell] : []),
              ...named(['Mountain', 'Forest']),
              ...filler(24),
            ]
          : seat === 'P3'
            ? [...(def.p3Field ?? []), ...filler(24)]
            : filler(24),
  }));

  const p2Hand = def.opponent ? [def.opponent.spell.name] : [];
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
          ...(def.p1Field ?? []).map((card) => card.name),
          ...(commander ? [commander.name] : []),
        ],
      },
      ...(def.opponent ? [{ playerId: 'P2' as const, cardNames: ['Mountain', 'Forest'] }] : []),
      ...(def.p3Field?.length
        ? [{ playerId: 'P3' as const, cardNames: def.p3Field.map((card) => card.name) }]
        : []),
    ],
    ...(def.p1Graveyard?.length
      ? {
          graveyard: [
            { playerId: 'P1' as const, cardNames: def.p1Graveyard.map((card) => card.name) },
          ],
        }
      : {}),
    ...def.prepared,
  };

  const seed = `pr10-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
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
    ...(def.opponent ? { decisionProviderOverrides: { P2: opponentProvider(def.opponent) } } : {}),
  };
}
