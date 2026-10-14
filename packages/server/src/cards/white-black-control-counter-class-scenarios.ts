import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine, interpretCard } from '@mtg/engine';
import type { DecisionProvider } from '@mtg/engine';
import type { GameId, OracleCard } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function fromPin(name: string): { card: OracleCard; sha256: string } {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing white-black-control Oracle pin: ${name}`);
  if (createHash('sha256').update(canonical(entry.card)).digest('hex') !== entry.sha256)
    throw new Error(`White-black-control Oracle fixture drift: ${name}`);
  return entry;
}

const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;
const motherRunes = fromPin('Mother of Runes');
const roleModel = fromPin('Reluctant Role Model');
const banditsTalent = fromPin("Bandit's Talent");
const sejiriShelter = fromPin('Sejiri Shelter // Sejiri Glacier');

const scenarios = [
  {
    id: 'reluctant-role-model-viewer',
    source: roleModel,
    title: 'Reluctant Role Model: attack, then choose a flying counter in your second main phase',
    clauseIds: ['reluctant-role-model-c01'],
    kind: 'survival' as const,
  },
  {
    id: 'reluctant-role-model-viewer-death-counter-transfer',
    source: roleModel,
    title: 'Reluctant Role Model: destroy your countered creature and transfer its counters',
    clauseIds: ['reluctant-role-model-c02'],
    kind: 'death-transfer' as const,
  },
  {
    id: 'sejiri-glacier-viewer-next-turn-mother-runes',
    source: sejiriShelter,
    title: 'Sejiri Glacier: play the tapped land, untap it next turn, then cast Mother of Runes',
    clauseIds: ['sejiri-shelter-sejiri-glacier-c02', 'sejiri-shelter-sejiri-glacier-c03'],
    kind: 'glacier-land' as const,
  },
  {
    id: 'bandit-s-talent-viewer',
    source: banditsTalent,
    title: "Bandit's Talent: normal cast, level 2 and 3, then punish an empty opponent hand",
    clauseIds: [
      'bandit-s-talent-c02',
      'bandit-s-talent-c03',
      'bandit-s-talent-c04',
      'bandit-s-talent-c05',
      'bandit-s-talent-c01',
    ],
    kind: 'upkeep' as const,
  },
  {
    id: 'bandit-s-talent-viewer-level-three-extra-draw',
    source: banditsTalent,
    title: "Bandit's Talent: pay through level 3 and draw for each opponent with one card",
    clauseIds: [
      'bandit-s-talent-c01',
      'bandit-s-talent-c03',
      'bandit-s-talent-c05',
      'bandit-s-talent-c06',
    ],
    kind: 'extra-draw' as const,
  },
] as const;

export const WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS = scenarios.map((scenario) => scenario.id);

function witness(
  name: string,
  options: {
    typeLine: string;
    types: string[];
    manaCost?: string | null;
    cmc?: number;
    oracleText?: string;
    power?: string | null;
    toughness?: string | null;
    colors?: OracleCard['colors'];
  },
): OracleCard {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    ...plains,
    oracleId: `lab-white-black-${slug}`,
    scryfallId: `lab-white-black-${slug}`,
    name,
    manaCost: options.manaCost === undefined ? '{0}' : options.manaCost,
    cmc: options.cmc ?? 0,
    colors: options.colors ?? [],
    colorIdentity: options.colors ?? [],
    typeLine: options.typeLine,
    supertypes: [],
    types: options.types,
    subtypes: options.types.includes('Creature') ? ['Bear'] : [],
    oracleText: options.oracleText ?? '',
    power:
      options.power === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.power,
    toughness:
      options.toughness === undefined
        ? options.types.includes('Creature')
          ? '2'
          : null
        : options.toughness,
    keywords: [],
    isBasicLand: false,
  };
}

function discardNonlandProvider(): DecisionProvider {
  return {
    decide(request) {
      const discard = request.legalActions.find((candidate) =>
        /discard/i.test(candidate.description),
      );
      const action =
        discard ??
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal action for ${request.decidingPlayer}`);
      const targets = (action.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.options[0]!,
      }));
      return {
        requestId: request.requestId,
        actionId: action.id,
        ...(targets.length > 0 ? { targets } : {}),
      };
    },
  };
}

export function whiteBlackControlCounterClassScenario(
  id: string,
  gameId: GameId,
): CardTestScenario {
  const entry = scenarios.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const isRoleModel = entry.source.card.name === 'Reluctant Role Model';
  const isRoleDeath = entry.kind === 'death-transfer';
  const isBanditDraw = entry.kind === 'extra-draw';
  const isGlacier = entry.kind === 'glacier-land';
  const isBandit = !isRoleModel && !isGlacier;
  const sourceName = entry.source.card.name;
  const roleHasteWitness = witness('Lab Role Model Haste Witness', {
    typeLine: 'Enchantment',
    types: ['Enchantment'],
    oracleText: 'Creatures you control have haste.',
  });
  const banditDiscard = witness('Lab Bandit Nonland Discard', {
    typeLine: 'Artifact',
    types: ['Artifact'],
  });
  const holdPriorityWitness = witness('Lab Priority Holding Instant', {
    typeLine: 'Instant',
    types: ['Instant'],
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
  });
  const holdingDef = interpretCard(holdPriorityWitness);
  if (!holdingDef.modeled || holdingDef.unmodeledReasons.length > 0)
    throw new Error(
      `Lab Priority Holding Instant must remain modeled: ${holdingDef.unmodeledReasons.join('; ')}`,
    );
  const roleDeathTarget = witness('Lab Role Model Countered Target', {
    typeLine: 'Creature — Bear',
    types: ['Creature'],
  });
  const roleDeathRecipient = witness('Lab Role Model Counter Recipient', {
    typeLine: 'Creature — Bear',
    types: ['Creature'],
  });
  const roleDestroyer = witness('Lab Role Model Destroy Spell', {
    typeLine: 'Instant',
    types: ['Instant'],
    manaCost: '{1}{B}',
    cmc: 2,
    oracleText: 'Destroy target creature.',
    colors: ['B'],
  });
  const destroyerDef = interpretCard(roleDestroyer);
  if (!destroyerDef.modeled || destroyerDef.unmodeledReasons.length > 0)
    throw new Error(
      `Lab Role Model Destroy Spell must remain modeled: ${destroyerDef.unmodeledReasons.join('; ')}`,
    );
  const libraryFillers = Array.from({ length: 10 }, () => swamp);
  const p1Lands = isRoleDeath
    ? [swamp, swamp, swamp, plains, plains, plains]
    : isRoleModel
      ? [plains, plains]
      : isGlacier
        ? []
        : Array.from({ length: 7 }, () => swamp);
  const players = (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => ({
    id: seat,
    deckId: `white-black-counter-class-${seat}`,
    commanders: [],
    cards:
      seat === 'P1'
        ? [
            entry.source.card,
            ...(isGlacier ? [motherRunes.card, holdPriorityWitness] : []),
            ...p1Lands,
            ...(isGlacier ? [plains] : []),
            ...(isRoleModel && !isRoleDeath ? [roleHasteWitness] : []),
            ...(isRoleDeath ? [roleDeathTarget, roleDeathRecipient, roleDestroyer] : []),
            ...libraryFillers,
          ]
        : isRoleModel || isGlacier
          ? [plains, swamp, ...libraryFillers]
          : [banditDiscard, plains, swamp, ...libraryFillers],
  }));
  const seed = `card-lab-${id}-v1`;

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: isRoleModel
        ? isRoleDeath
          ? [
              'Cast Reluctant Role Model normally from your hand for {1}{W}.',
              'Normally cast Lab Role Model Destroy Spell targeting your own Lab Role Model Countered Target, which has two +1/+1 counters and a flying counter.',
              'When it dies, choose Lab Role Model Counter Recipient as the target for Reluctant Role Model’s trigger and verify both counter types transfer.',
            ]
          : [
              'Cast Reluctant Role Model normally from your hand.',
              'Attack P2 with Reluctant Role Model; Lab Role Model Haste Witness only supplies haste.',
              'In your second main phase, choose the flying counter and verify its counter and keyword.',
            ]
        : isGlacier
          ? [
              'Normally play Sejiri Glacier from the back face of Sejiri Shelter; it enters tapped.',
              'Pass through P2, P3, P4, then your next turn. Do not cast Lab Priority Holding Instant.',
              'After Sejiri Glacier untaps, leave the drawn Plains in your hand and normally cast Mother of Runes for {W} using only the Glacier.',
            ]
          : isBanditDraw
            ? [
                "Cast Bandit's Talent normally, then activate its {B} Level 2 and {3}{B} Level 3 abilities with their real costs.",
                'Pass through P2, P3, P4, then your next turn; each opponent draws one card after discarding to the enters ability.',
                'At your next draw step, observe the normal draw plus one additional card for each opponent with one card in hand.',
              ]
            : [
                "Cast Bandit's Talent normally; each opponent chooses its available single nonland discard.",
                "Activate Bandit's Talent's {B} Level 2 ability, then its {3}{B} Level 3 ability.",
                'Pass through the production continuation to P2 upkeep and observe P2 lose 2 life with no cards in hand.',
              ],
      expectedOutcome: isRoleModel
        ? isRoleDeath
          ? 'The normal destroy spell kills your creature with two +1/+1 counters and a flying counter. Reluctant Role Model targets your other creature, which receives both counter types.'
          : 'After the real combat attack taps Reluctant Role Model, its second-main Survival trigger lets its controller choose a flying counter; the permanent shows a flying counter and flying.'
        : isGlacier
          ? 'Sejiri Glacier enters tapped and cannot pay for Mother of Runes until your next turn. After the Glacier untaps, the normal draw is Plains; Mother of Runes is cast for {W} using only the Glacier, and the unplayed Plains remains in hand.'
          : isBanditDraw
            ? "Bandit's Talent reaches level 3 through two paid activations. Each opponent has one card at your next draw step, so you draw four cards total: one normal draw and three additional cards."
            : "Bandit's Talent is cast and both levels are paid normally. The opponent empties their hand to satisfy its ETB choice, then loses 2 life during their next upkeep under the level 2 ability.",
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
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
    engine: new Engine(
      { gameId, seed, players, turnCap: 8 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: isGlacier ? 2 : 1,
          hand: [
            {
              playerId: 'P1',
              cardNames: [
                sourceName,
                ...(isRoleDeath ? [roleDestroyer.name] : []),
                ...(isGlacier ? [motherRunes.card.name, holdPriorityWitness.name] : []),
              ],
            },
            ...(isBandit
              ? (['P2', 'P3', 'P4'] as const).map((playerId) => ({
                  playerId,
                  cardNames: [banditDiscard.name],
                }))
              : []),
          ],
          battlefield: [
            { playerId: 'P1', cardNames: p1Lands.map((land) => land.name) },
            ...(isRoleModel && !isRoleDeath
              ? [{ playerId: 'P1', cardNames: [roleHasteWitness.name] }]
              : []),
            ...(isRoleDeath
              ? [
                  {
                    playerId: 'P1',
                    cardNames: [roleDeathTarget.name],
                    counters: { '+1/+1': 2, flying: 1 },
                  },
                  { playerId: 'P1', cardNames: [roleDeathRecipient.name] },
                ]
              : []),
          ],
          ...(isRoleModel && !isRoleDeath
            ? { continueThroughCombat: true, continueToPostcombatMain: true }
            : isGlacier
              ? {
                  continueThroughPrecombatMains: 4,
                  libraryTop: [{ playerId: 'P1', cardNames: [plains.name] }],
                }
              : isBanditDraw
                ? { continueThroughPrecombatMains: 4 }
                : isRoleDeath
                  ? {}
                  : { continueToNextUpkeep: true }),
        },
      },
    ),
    decisionProviderOverrides: isBandit
      ? {
          P2: discardNonlandProvider(),
          P3: discardNonlandProvider(),
          P4: discardNonlandProvider(),
        }
      : {},
  };
}
