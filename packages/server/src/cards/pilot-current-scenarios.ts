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
export const GIANT = lab('Pilot Lab Giant', 'Creature — Giant', '{4}{G}', '', ['G'], ['4', '4']);
export const BEAR = lab('Pilot Lab Bear', 'Creature — Bear', '{1}{G}', '', ['G'], ['2', '2']);
export const SAPROLING = lab(
  'Pilot Lab Saproling',
  'Sorcery',
  '{G}',
  'Create a 1/1 green Saproling creature token.',
  ['G'],
);
export const ELF = lab('Pilot Lab Elf', 'Creature — Elf', '{G}', '', ['G'], ['1', '1']);
export const GOBLIN = lab('Pilot Lab Goblin', 'Creature — Goblin', '{G}', '', ['G'], ['1', '1']);
export const ELF_WARRIOR = lab(
  'Pilot Lab Elf Warrior',
  'Creature — Elf Warrior',
  '{G}',
  '{G}: This creature gets +1/+1 until end of turn.',
  ['G'],
  ['1', '1'],
);
export const DOOM = lab('Pilot Lab Doom', 'Sorcery', '{B}', 'Destroy target creature.', ['B']);
export const RELIC = lab('Pilot Lab Relic', 'Artifact', '{1}', '', []);
export const WRATH = lab('Pilot Lab Wrath', 'Sorcery', '{B}', 'Destroy all creatures.', ['B']);
/**
 * Always in P1's hand: a free spell P1 can cast whenever it has priority, so the viewer is still
 * given priority when the card under test leaves P1 nothing else to do.
 */
export const TRINKET = lab('Pilot Lab Trinket', 'Artifact', '{0}', '', []);

const SUPPORT_CARDS = [
  BLACK_SORCERY,
  RED_SORCERY,
  GIANT,
  BEAR,
  SAPROLING,
  ELF,
  GOBLIN,
  ELF_WARRIOR,
  DOOM,
  WRATH,
  RELIC,
  TRINKET,
];

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
  /** `p1Top` is the top as is: the scenario starts after P1's draw (Bolas's Citadel). */
  p1TopUndrawn?: true;
  /** P2's library top, as is: P2 draws nothing before P1's main phase. */
  p2Top?: string[];
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
  {
    id: 'pilot-current-explore-viewer-second-land',
    cardName: 'Explore',
    title: 'Explore: a second land this turn, and a card',
    instructions: [
      'Play Forest from your hand.',
      'Cast Explore with your two other Forests.',
      'Play Plains from your hand.',
    ],
    expectedOutcome:
      'Both lands enter, you draw a card, and Island stays in your hand: no third land play.',
    lines: [1, 2],
    p1Hand: ['Explore', 'Forest', 'Plains', 'Island'],
    p1Field: ['Forest', 'Forest'],
  },
  {
    id: 'pilot-current-great-henge-viewer-cast-reduced',
    cardName: 'The Great Henge',
    title: 'The Great Henge: a 4-power creature makes it cost {3}{G}{G}',
    instructions: ['Cast The Great Henge with your five Forests.'],
    expectedOutcome: 'The Great Henge costs {3}{G}{G} and resolves; all five Forests are tapped.',
    lines: [1],
    p1Hand: ['The Great Henge'],
    p1Field: ['Pilot Lab Giant', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'],
  },
  {
    id: 'pilot-current-great-henge-viewer-enter-trigger',
    cardName: 'The Great Henge',
    title: 'The Great Henge: its {G}{G} casts a creature, which gets a counter and draws',
    instructions: ['Cast Pilot Lab Bear, tapping The Great Henge for {G}{G}.'],
    expectedOutcome:
      'You gain 2 life; Pilot Lab Bear enters with a +1/+1 counter and you draw a card.',
    lines: [2, 3],
    p1Hand: ['Pilot Lab Bear'],
    p1Field: ['The Great Henge'],
  },
  {
    id: 'pilot-current-great-henge-viewer-token-ignored',
    cardName: 'The Great Henge',
    title: 'The Great Henge: a creature token entering gets nothing',
    instructions: ['Cast Pilot Lab Saproling with your Forest.'],
    expectedOutcome: 'The Saproling token enters with no counter and you draw no card.',
    lines: [3],
    p1Hand: ['Pilot Lab Saproling'],
    p1Field: ['The Great Henge', 'Forest'],
  },
  {
    id: 'pilot-current-great-henge-viewer-opponent-creature',
    cardName: 'The Great Henge',
    title: "The Great Henge: an opponent's creature entering gets nothing",
    instructions: ["On P2's turn, P2 casts Pilot Lab Bear; pass priority."],
    expectedOutcome: "P2's Pilot Lab Bear enters with no counter and you draw no card.",
    lines: [3],
    p1Field: ['The Great Henge'],
    p2Hand: ['Pilot Lab Bear'],
    p2Field: ['Forest', 'Forest'],
    opponent: { seat: 'P2', cast: 'Pilot Lab Bear' },
    prepared: { currentTurnPlayer: 'P2' },
  },
  {
    id: 'pilot-current-gamble-viewer-tutor',
    cardName: 'Gamble',
    title: 'Gamble: find a card, then discard one at random',
    instructions: ['Cast Gamble with your Mountain.', 'Find Pilot Lab Bear in your library.'],
    expectedOutcome:
      'Pilot Lab Bear comes to your hand, then one of the two cards in your hand is discarded at random and your library is shuffled.',
    lines: [1],
    p1Hand: ['Gamble'],
    p1Field: ['Mountain'],
    p1Top: ['Pilot Lab Bear'],
  },
  // The creature types offered as Secluded Courtyard enters come from P1's decklist, so each
  // scenario keeps a second type in the library.
  {
    id: 'pilot-current-secluded-courtyard-viewer-cast-chosen',
    cardName: 'Secluded Courtyard',
    title: 'Secluded Courtyard: choose Elf, then its colored mana casts an Elf',
    instructions: [
      'Play Secluded Courtyard and choose Elf.',
      'Cast Pilot Lab Elf, tapping Secluded Courtyard for {G}.',
    ],
    expectedOutcome: 'Pilot Lab Elf is cast with the restricted mana and resolves.',
    lines: [1, 3],
    p1Hand: ['Secluded Courtyard', 'Pilot Lab Elf'],
    p1Top: ['Pilot Lab Goblin'],
  },
  {
    id: 'pilot-current-secluded-courtyard-viewer-other-type',
    cardName: 'Secluded Courtyard',
    title: 'Secluded Courtyard: choose Elf, and a Goblin cannot be cast with it',
    instructions: [
      'Play Secluded Courtyard and choose Elf.',
      'Try to cast Pilot Lab Goblin with Secluded Courtyard.',
    ],
    expectedOutcome: 'Pilot Lab Goblin, not an Elf, cannot be cast with the restricted mana.',
    lines: [1, 3],
    p1Hand: ['Secluded Courtyard', 'Pilot Lab Goblin'],
    p1Top: ['Pilot Lab Elf'],
  },
  {
    id: 'pilot-current-secluded-courtyard-viewer-activate',
    cardName: 'Secluded Courtyard',
    title: "Secluded Courtyard: its colored mana pays for an Elf creature's ability",
    instructions: [
      'Play Secluded Courtyard and choose Elf.',
      "Activate Pilot Lab Elf Warrior's {G} ability, tapping Secluded Courtyard for {G}.",
    ],
    expectedOutcome: 'Pilot Lab Elf Warrior gets +1/+1 until end of turn: it is 2/2.',
    lines: [1, 3],
    p1Hand: ['Secluded Courtyard'],
    p1Field: ['Pilot Lab Elf Warrior'],
    p1Top: ['Pilot Lab Goblin'],
  },
  {
    id: 'pilot-current-morbid-opportunist-viewer-draw',
    cardName: 'Morbid Opportunist',
    title: "Morbid Opportunist: an opponent's creature dies, and you draw",
    instructions: ["Cast Pilot Lab Doom on P2's Pilot Lab Bear with your Swamp."],
    expectedOutcome: 'Pilot Lab Bear dies; Morbid Opportunist triggers and you draw a card.',
    lines: [1],
    p1Hand: ['Pilot Lab Doom'],
    p1Field: ['Morbid Opportunist', 'Swamp'],
    p2Field: ['Pilot Lab Bear'],
  },
  {
    id: 'pilot-current-morbid-opportunist-viewer-once',
    cardName: 'Morbid Opportunist',
    title: 'Morbid Opportunist: a second death the same turn draws nothing',
    instructions: [
      "Cast Pilot Lab Doom on P2's Pilot Lab Bear.",
      "Cast the second Pilot Lab Doom on P2's Pilot Lab Giant.",
    ],
    expectedOutcome: 'Both creatures die, but you draw only one card: it triggers once each turn.',
    lines: [1],
    p1Hand: ['Pilot Lab Doom', 'Pilot Lab Doom'],
    p1Field: ['Morbid Opportunist', 'Swamp', 'Swamp'],
    p2Field: ['Pilot Lab Bear', 'Pilot Lab Giant'],
  },
  {
    id: 'pilot-current-morbid-opportunist-viewer-wrath',
    cardName: 'Morbid Opportunist',
    title: 'Morbid Opportunist: dying with two other creatures, it draws one card',
    instructions: ['Cast Pilot Lab Wrath with your Swamp.'],
    expectedOutcome:
      'Every creature dies at once; Morbid Opportunist sees the others die and you draw one card.',
    lines: [1],
    p1Hand: ['Pilot Lab Wrath'],
    p1Field: ['Morbid Opportunist', 'Swamp', 'Pilot Lab Bear'],
    p2Field: ['Pilot Lab Giant'],
  },
  {
    id: 'pilot-current-syr-konrad-viewer-mill-creature',
    cardName: 'Syr Konrad, the Grim',
    title: "Syr Konrad: each player mills, and P2's milled creature pings each opponent",
    instructions: ["Activate Syr Konrad's {1}{B} ability with your two Swamps."],
    expectedOutcome:
      'Each player mills a card; P2 mills Pilot Lab Bear, so Konrad deals 1 damage to each opponent.',
    lines: [2],
    p1Field: ['Syr Konrad, the Grim', 'Swamp', 'Swamp'],
    p2Top: ['Pilot Lab Bear'],
  },
  {
    id: 'pilot-current-syr-konrad-viewer-mill-lands',
    cardName: 'Syr Konrad, the Grim',
    title: 'Syr Konrad: milling only lands deals no damage',
    instructions: ["Activate Syr Konrad's {1}{B} ability with your two Swamps."],
    expectedOutcome: 'Each player mills a land; Konrad does not trigger and everyone stays at 40.',
    lines: [2],
    p1Field: ['Syr Konrad, the Grim', 'Swamp', 'Swamp'],
  },
  {
    id: 'pilot-current-untimely-malfunction-viewer-destroy-artifact',
    cardName: 'Untimely Malfunction',
    title: "Untimely Malfunction: destroy P2's artifact",
    instructions: [
      "Cast Untimely Malfunction choosing its first mode, targeting P2's Pilot Lab Relic.",
    ],
    expectedOutcome: 'Pilot Lab Relic is destroyed.',
    lines: [1, 2],
    p1Hand: ['Untimely Malfunction'],
    p1Field: ['Mountain', 'Mountain'],
    p2Field: ['Pilot Lab Relic'],
  },
  {
    id: 'pilot-current-untimely-malfunction-viewer-redirect',
    cardName: 'Untimely Malfunction',
    title: "Untimely Malfunction: P2's Doom is turned onto P2's own Giant",
    instructions: [
      "On P2's turn, P2 casts Pilot Lab Doom at your Pilot Lab Bear.",
      'In response, cast Untimely Malfunction choosing its second mode, targeting Pilot Lab Doom.',
      'Choose Pilot Lab Giant as its new target.',
    ],
    expectedOutcome:
      'You choose Pilot Lab Giant over Pilot Lab Elf; Pilot Lab Doom destroys the Giant and your Pilot Lab Bear survives.',
    lines: [1, 3],
    p1Hand: ['Untimely Malfunction'],
    p1Field: ['Pilot Lab Bear', 'Mountain', 'Mountain'],
    p2Hand: ['Pilot Lab Doom'],
    p2Field: ['Swamp', 'Pilot Lab Giant', 'Pilot Lab Elf'],
    opponent: { seat: 'P2', cast: 'Pilot Lab Doom', targets: ['Pilot Lab Bear'] },
    prepared: { currentTurnPlayer: 'P2' },
  },
  {
    id: 'pilot-current-untimely-malfunction-viewer-cant-block',
    cardName: 'Untimely Malfunction',
    title: "Untimely Malfunction: P2's Giant can't block this turn",
    instructions: [
      "Cast Untimely Malfunction choosing its third mode, targeting P2's Pilot Lab Giant.",
      'Attack P2 with Pilot Lab Bear.',
    ],
    expectedOutcome: 'Only Pilot Lab Elf may block; Pilot Lab Giant is not offered as a blocker.',
    lines: [1, 4],
    p1Hand: ['Untimely Malfunction'],
    p1Field: ['Pilot Lab Bear', 'Mountain', 'Mountain'],
    p2Field: ['Pilot Lab Giant', 'Pilot Lab Elf'],
    prepared: { continueThroughCombat: true },
  },
  {
    id: 'pilot-current-bolas-citadel-viewer-cast-for-life',
    cardName: "Bolas's Citadel",
    title: "Bolas's Citadel: cast the top card of your library for life",
    instructions: [
      "Cast Pilot Lab Doom from the top of your library, paying 1 life, targeting P2's Pilot Lab Giant.",
    ],
    expectedOutcome:
      'You pay 1 life rather than {B}, your Swamp stays untapped, and Pilot Lab Giant is destroyed.',
    lines: [1, 2],
    p1Field: ["Bolas's Citadel", 'Swamp'],
    p1Top: ['Pilot Lab Doom'],
    p1TopUndrawn: true,
    p2Field: ['Pilot Lab Giant'],
  },
  {
    id: 'pilot-current-bolas-citadel-viewer-play-land',
    cardName: "Bolas's Citadel",
    title: "Bolas's Citadel: play a land from the top of your library",
    instructions: ['Play the Mountain on top of your library.'],
    expectedOutcome: 'The Mountain enters as your land for the turn, and no life is paid.',
    lines: [2],
    p1Field: ["Bolas's Citadel"],
    p1Top: ['Mountain'],
    p1TopUndrawn: true,
  },
  {
    id: 'pilot-current-bolas-citadel-viewer-sacrifice-ten',
    cardName: "Bolas's Citadel",
    title: "Bolas's Citadel: sacrifice ten nonland permanents",
    instructions: [
      "Activate Bolas's Citadel, sacrificing it and your nine Pilot Lab Relics; the Swamp can't be sacrificed.",
    ],
    expectedOutcome: 'Each opponent loses 10 life; only your Swamp is left.',
    lines: [3],
    p1Field: ["Bolas's Citadel", 'Swamp', ...Array<string>(9).fill('Pilot Lab Relic')],
  },
  {
    id: 'pilot-current-etali-primal-storm-viewer-cast-both',
    cardName: 'Etali, Primal Storm',
    title: "Etali: attack, then cast your own and P2's exiled spells free",
    instructions: [
      'Attack P2 with Etali, Primal Storm.',
      "When its trigger resolves, cast P2's Pilot Lab Saproling, then your Pilot Lab Red Sorcery, both free.",
    ],
    expectedOutcome:
      "You get a Saproling and gain 2 life; P3's and P4's lands stay in exile, and Etali deals 6 to P2.",
    lines: [1],
    p1Field: ['Etali, Primal Storm'],
    p1Top: ['Pilot Lab Red Sorcery'],
    p1TopUndrawn: true,
    p2Top: ['Pilot Lab Saproling'],
    prepared: { continueThroughCombat: true },
  },
  {
    id: 'pilot-current-etali-primal-storm-viewer-cast-none',
    cardName: 'Etali, Primal Storm',
    title: 'Etali: attack and cast nothing',
    instructions: [
      'Attack P2 with Etali, Primal Storm.',
      'When its trigger resolves, choose Done.',
    ],
    expectedOutcome: "Each player's top card stays in exile; nothing is cast.",
    lines: [1],
    p1Field: ['Etali, Primal Storm'],
    p2Top: ['Pilot Lab Saproling'],
    prepared: { continueThroughCombat: true },
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
  const p2Cards = [...(def.p2Hand ?? []), ...names(def.p2Field), ...(def.p2Top ?? [])];
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
    ...(def.p1Top?.length || def.p2Top?.length
      ? {
          libraryTop: [
            ...(def.p1Top?.length
              ? [
                  {
                    playerId: 'P1' as const,
                    cardNames: def.p1TopUndrawn ? def.p1Top : ['Forest', ...def.p1Top],
                  },
                ]
              : []),
            ...(def.p2Top?.length ? [{ playerId: 'P2' as const, cardNames: def.p2Top }] : []),
          ],
        }
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
