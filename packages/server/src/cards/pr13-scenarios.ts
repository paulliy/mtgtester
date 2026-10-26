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
        '../../../../packages/engine/tests/fixtures/coverage-pr13-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: Pin[] }
).cards;

for (const entry of pins)
  if (createHash('sha256').update(JSON.stringify(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`PR13 Oracle pin drift: ${entry.card.name}`);

function pin(name: string): Pin {
  const found = pins.find((entry) => entry.card.name === name);
  if (!found) throw new Error(`Missing PR13 Oracle pin ${name}`);
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
  const base = supportCard('Forest', 'PR13 support land');
  const [left, right] = typeLine.split(' — ');
  const words = left!.split(' ');
  const id = `lab-pr13-${slug(name)}`;
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
  'PR13 Lab Shock',
  'Instant',
  '{R}',
  'PR13 Lab Shock deals 2 damage to any target.',
  ['R'],
);
export const BEAR = lab('PR13 Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const CUB = lab('PR13 Lab Cub', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const WHELP = lab('PR13 Lab Whelp', 'Creature — Dog', '{1}{G}', '', ['G'], ['2', '2']);
export const LIFELINKER = lab(
  'PR13 Lab Lifelinker',
  'Creature — Cleric',
  '{W}',
  'Lifelink',
  ['W'],
  ['1', '1'],
);
export const INFECTOR = lab(
  'PR13 Lab Infector',
  'Creature — Horror',
  '{B}',
  'Infect',
  ['B'],
  ['1', '1'],
);
export const GADGET = lab('PR13 Lab Gadget', 'Artifact', '{1}', '', []);
export const ORNAMENT = lab('PR13 Lab Ornament', 'Artifact', '{0}', '', []);
export const TOTEM = lab('PR13 Lab Totem', 'Artifact', '{2}', '', []);
export const RELIC = lab('PR13 Lab Relic', 'Artifact', '{3}', '', []);
/**
 * Always in P1's hand: a free spell P1 can cast at any time it has priority, so the viewer is
 * still given priority after the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('PR13 Lab Trinket', 'Artifact', '{0}', '', []);

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
  id: `pr13-${slug(cardName)}-viewer-${kind}`,
  cardName,
  title,
  lines,
  instructions,
  expectedOutcome,
  ...rest,
});

const lands = (name: string, count: number) => Array.from({ length: count }, () => name);
const COMBAT: Partial<PreparedScenarioSpec> = { continueThroughCombat: true };

const MASTER = 'Master of Ceremonies';
const SECURITRON = 'Securitron Squadron';
const COUP = 'Confiscation Coup';
const INSTINCT = 'Overwhelming Instinct';
const CHARM = 'Rakdos Charm';

/** P4's turn passes, then P1's untap, upkeep, draw and precombat main run through production. */
const P1_TURN_BEGINS: Partial<PreparedScenarioSpec> = {
  currentTurnPlayer: 'P4',
  continueThroughPrecombatMains: 1,
};

const DEFS: Def[] = [
  // PR13.01 Master of Ceremonies
  entry(
    MASTER,
    'money',
    'Master of Ceremonies: P2 chooses money, then your Treasure pays for a spell',
    [1],
    [
      'Pass priority through your upkeep. P2 chooses money; P3 and P4 choose secrets.',
      'Cast PR13 Lab Gadget, paying with your Treasure.',
    ],
    'You and P2 each create a Treasure. Your Treasure is sacrificed to pay for PR13 Lab Gadget, and P2 keeps its Treasure.',
    {
      p1Hand: [GADGET],
      p1Field: [card(MASTER)],
      opponent: { seat: 'P2', targets: [], choose: /^Money$/ },
      otherOpponents: [
        { seat: 'P3', targets: [], choose: /^Secrets$/ },
        { seat: 'P4', targets: [], choose: /^Secrets$/ },
      ],
      prepared: P1_TURN_BEGINS,
    },
  ),

  // PR13.02 Securitron Squadron
  entry(
    SECURITRON,
    'squad-copy',
    'Securitron Squadron: squad once, so the token copy gets two +1/+1 counters',
    [1, 3],
    ['Cast Securitron Squadron, paying squad once.'],
    'Two Securitron Squadrons enter. The token copy has two +1/+1 counters; the original has none.',
    {
      p1Hand: [card(SECURITRON)],
      p1Lands: lands('Plains', 5),
    },
  ),
  entry(
    SECURITRON,
    'nontoken',
    'Securitron Squadron: a nontoken creature entering gets no counter',
    [3],
    ['Cast PR13 Lab Bear.'],
    'PR13 Lab Bear enters with no +1/+1 counter.',
    {
      p1Hand: [BEAR],
      p1Field: [card(SECURITRON)],
      p1Lands: lands('Forest', 2),
    },
  ),

  // PR13.03 Confiscation Coup
  entry(
    COUP,
    'zero-mana-value',
    'Confiscation Coup: pay 0 energy to take a mana value 0 artifact',
    [1],
    ['Cast Confiscation Coup targeting P2’s PR13 Lab Ornament.', 'Choose to pay 0 energy.'],
    'You get four energy, pay none, and gain control of PR13 Lab Ornament.',
    {
      p1Hand: [card(COUP)],
      p1Lands: lands('Island', 5),
      p2Field: [ORNAMENT],
    },
  ),
  entry(
    COUP,
    'pay-mana-value',
    'Confiscation Coup: pay 2 energy to take a mana value 2 artifact',
    [1],
    ['Cast Confiscation Coup targeting P2’s PR13 Lab Totem.', 'Choose to pay 2 energy.'],
    'You get four energy, pay two, and gain control of PR13 Lab Totem with two energy left.',
    {
      p1Hand: [card(COUP)],
      p1Lands: lands('Island', 5),
      p2Field: [TOTEM],
    },
  ),

  // PR13.04 Overwhelming Instinct
  entry(
    INSTINCT,
    'attacker-removed',
    'Overwhelming Instinct: an attacker dies with the trigger on the stack, you still draw',
    [1],
    [
      'Attack P2 with PR13 Lab Bear, PR13 Lab Cub and PR13 Lab Whelp.',
      'With the draw trigger on the stack, cast PR13 Lab Shock on your attacking PR13 Lab Bear.',
    ],
    'PR13 Lab Bear dies, and the draw trigger still resolves: you draw PR13 Lab Relic.',
    {
      p1Hand: [SHOCK],
      p1Field: [card(INSTINCT), BEAR, CUB, WHELP],
      p1Lands: ['Mountain'],
      p1LibraryTop: [RELIC],
      prepared: COMBAT,
    },
  ),
  entry(
    INSTINCT,
    'two-attackers',
    'Overwhelming Instinct: only two attackers, so no card is drawn',
    [1],
    ['Attack P2 with PR13 Lab Bear and PR13 Lab Cub.'],
    'The trigger does not fire; PR13 Lab Relic stays on top of your library.',
    {
      p1Hand: [],
      p1Field: [card(INSTINCT), BEAR, CUB],
      p1LibraryTop: [RELIC],
      prepared: COMBAT,
    },
  ),

  // PR13.05 Rakdos Charm
  entry(
    CHARM,
    'creature-sources',
    'Rakdos Charm: each creature is the source of its own damage',
    [1, 4],
    ['Cast Rakdos Charm, choosing “Each creature deals 1 damage to its controller.”'],
    'You take 1 and gain 1 from your lifelinker. P2 takes 1 from its bear and gets a poison counter from its infector.',
    {
      p1Hand: [card(CHARM)],
      p1Field: [LIFELINKER],
      p1Lands: ['Swamp', 'Mountain'],
      p2Field: [INFECTOR, BEAR],
    },
  ),
];

export const PR13_SCENARIOS = DEFS.map(({ id, cardName, title }) => ({ id, cardName, title }));

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

/** The clause ids a PR13 card's Oracle text declares: front lines, then spell-face lines. */
export function pr13ClauseIds(oracle: OracleCard): string[] {
  const base = `pr13-${slug(oracle.name)}-clause-`;
  return [
    ...oracle.oracleText.split('\n').map((_, index) => `${base}${index + 1}`),
    ...(oracle.backFace?.oracleText.split('\n') ?? []).map(
      (_, index) => `${base}face-${index + 1}`,
    ),
  ];
}

/** Source-pinned prepared Card Test Lab scenarios for the five cards fixed in the PR13 override review. */
export function pr13Scenario(id: string, gameId: GameId): CardTestScenario {
  const def = DEFS.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown PR13 scenario ${id}`);
  const source = pin(def.cardName);
  const p1Field = (def.p1Field ?? []).map(placed);
  const p2Field = (def.p2Field ?? []).map(placed);
  const p1Lands = def.p1Lands ?? [];
  const p2Lands = def.p2Lands ?? [];
  const cardNamed = new Map<string, OracleCard>();
  for (const basic of ['Forest', 'Island', 'Mountain', 'Plains', 'Swamp'])
    cardNamed.set(basic, supportCard(basic, 'PR13 support land'));
  const named = (names: string[]) => names.map((name) => cardNamed.get(name)!);
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      supportCard(['Forest', 'Plains', 'Swamp'][index % 3]!, 'PR13 filler land'),
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
    deckId: `pr13-${seat}`,
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

  const seed = `pr13-${id}-seed-1`;
  const engine = new Engine({ gameId, seed, players, turnCap: 12 }, { preparedScenario: prepared });
  const base = `pr13-${slug(def.cardName)}-clause-`;
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
