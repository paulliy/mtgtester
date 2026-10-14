import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine, type DecisionProvider } from '@mtg/engine';
import { NO_BLOCK_TARGET, type GameId, type OracleCard, type PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
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

const entries = [
  {
    id: 'breena-viewer-flying-blocker',
    source: fromPin('Breena, the Demagogue'),
    clauseIds: ['breena-the-demagogue-c01'],
    title: 'Breena: flying attacker connects past a ground blocker',
    kind: 'flying' as const,
  },
  {
    id: 'archfiend-of-ifnir-viewer-flying-blocker',
    source: fromPin('Archfiend of Ifnir'),
    clauseIds: ['archfiend-of-ifnir-c01'],
    title: 'Archfiend of Ifnir: flying attacker connects past a ground blocker',
    kind: 'flying' as const,
  },
  {
    id: 'hypnotic-specter-viewer-flying-blocker',
    source: fromPin('Hypnotic Specter'),
    clauseIds: ['hypnotic-specter-c01'],
    title: 'Hypnotic Specter: flying attacker connects past a ground blocker',
    kind: 'flying' as const,
  },
  {
    id: 'aven-interrupter-viewer-flying-blocker',
    source: fromPin('Aven Interrupter'),
    clauseIds: ['aven-interrupter-c02'],
    title: 'Aven Interrupter: flying attacker connects past a ground blocker',
    kind: 'flying' as const,
  },
  {
    id: 'the-haunt-of-hightower-viewer-flying-blocker',
    source: fromPin('The Haunt of Hightower'),
    clauseIds: ['the-haunt-of-hightower-c01'],
    title: 'The Haunt of Hightower: flying and lifelink connect past a ground blocker',
    kind: 'haunt' as const,
  },
  {
    id: 'doorkeeper-thrull-viewer-flying-blocker',
    source: fromPin('Doorkeeper Thrull'),
    clauseIds: ['doorkeeper-thrull-c02'],
    title: 'Doorkeeper Thrull: flying attacker connects past a ground blocker',
    kind: 'flying' as const,
  },
  {
    id: 'archon-of-absolution-viewer-protection-blocker',
    source: fromPin('Archon of Absolution'),
    clauseIds: ['archon-of-absolution-c01', 'archon-of-absolution-c02'],
    title: 'Archon of Absolution: protection from white prevents a white flyer from blocking',
    kind: 'protection' as const,
  },
  {
    id: 'tergrid-front-viewer-menace-blocker',
    source: fromPin("Tergrid, God of Fright // Tergrid's Lantern"),
    clauseIds: ['tergrid-god-of-fright-tergrid-s-lantern-c01'],
    title: 'Tergrid: menace prevents a single ground blocker from stopping the attack',
    kind: 'menace' as const,
  },
] as const;

export const WHITE_BLACK_KEYWORD_SCENARIO_IDS = entries.map((entry) => entry.id);

function witness(
  name: string,
  options: {
    power: number;
    toughness: number;
    flying?: boolean;
    color?: 'W';
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
    manaCost: '{3}',
    cmc: 3,
    colors: options.color === undefined ? [] : [options.color],
    colorIdentity: options.color === undefined ? [] : [options.color],
    typeLine: 'Creature — Bird',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Bird'],
    oracleText: options.flying === true ? 'Flying' : '',
    power: String(options.power),
    toughness: String(options.toughness),
    keywords: options.flying === true ? ['Flying'] : [],
    isBasicLand: false,
  };
}

function makeSeats(cards: Record<PlayerId, OracleCard[]>, suffix: string) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const deckCards = cards[seat];
    if (deckCards === undefined) throw new Error(`Missing prepared deck for ${seat}`);
    const config = {
      id: seat,
      deckId: `white-black-keywords-${suffix}-${seat}`,
      commanders: [],
      cards: deckCards,
    };
    return {
      seat,
      config,
      deckSnapshotId: null,
      summary: {
        seat,
        deckId: config.deckId,
        label: seat,
        commanderNames: [],
        colorIdentity: [],
        archetypeTag: 'card-test-lab',
      },
    };
  });
}

function blockerDecisionProvider(preferredAttacker: string): DecisionProvider {
  return {
    decide(request) {
      const declaration = request.legalActions.find((action) => action.type === 'blockDeclaration');
      if (request.decisionType === 'declareBlockers') {
        if (declaration === undefined)
          throw new Error(`P2 has no block-declaration action for ${request.decisionType}`);
        const subjects = request.presentation?.blockDeclaration?.subjects ?? [];
        const targets = (declaration.targets ?? []).map((slot, index) => {
          const subject = subjects[index];
          const preferred = subject?.attackers.find(
            (attacker) =>
              attacker.name === preferredAttacker && slot.options.includes(attacker.attackerId),
          );
          const fallback = slot.options.find((option) => option !== NO_BLOCK_TARGET);
          const choice =
            preferred?.attackerId ??
            fallback ??
            slot.options.find((option) => option === NO_BLOCK_TARGET);
          if (choice === undefined)
            throw new Error(`P2 has no legal choice for block slot ${slot.slot}`);
          return { slot: slot.slot, choice };
        });
        return { requestId: request.requestId, actionId: declaration.id, targets };
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

export function whiteBlackControlKeywordScenario(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control scenario ${id}`);

  const source = entry.source.card;
  const frontName = source.name.split(' // ')[0] ?? source.name;
  const isProtection = entry.kind === 'protection';
  const isHaunt = entry.kind === 'haunt';
  const isMenace = entry.kind === 'menace';
  const attackWitness = isProtection
    ? witness('Lab P1 Colorless Flying Witness', { power: 2, toughness: 2, flying: true })
    : undefined;
  const blocker = witness(
    isProtection ? 'Lab P2 White Flying Blocker' : 'Lab P2 Ground Blocker',
    isProtection
      ? { power: 3, toughness: 3, flying: true, color: 'W' }
      : { power: 3, toughness: 3 },
  );
  const filler = Array.from({ length: 16 }, () => swamp);
  const players = makeSeats(
    {
      P1: [source, ...(attackWitness === undefined ? [] : [attackWitness]), ...filler],
      P2: [blocker, ...filler],
      P3: [...filler],
      P4: [...filler],
    },
    id,
  );
  const damage = Number(source.power);
  const lifeTotals = [
    { playerId: 'P1' as const, life: 35 },
    { playerId: 'P2' as const, life: 40 },
    { playerId: 'P3' as const, life: 40 },
    { playerId: 'P4' as const, life: 40 },
  ];
  const battlefield = [
    { playerId: 'P1' as const, cardNames: [source.name] },
    ...(attackWitness === undefined
      ? []
      : [{ playerId: 'P1' as const, cardNames: [attackWitness.name] }]),
    { playerId: 'P2' as const, cardNames: [blocker.name] },
  ];
  const seed = `card-lab-${id}-v1`;

  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        'The tested source begins on the battlefield from a previous turn. Declare it attacking P2; P2 uses a normal blocker decision and combat then resolves.',
        ...(isProtection
          ? [
              'Also attack with Lab P1 Colorless Flying Witness. P2 prefers to block the source when it is legal, otherwise it blocks the witness.',
            ]
          : []),
        ...(isMenace
          ? [
              'P2 attempts to block Tergrid with one creature; the normal declaration is checked and repaired for menace.',
            ]
          : []),
      ],
      expectedOutcome: isProtection
        ? `P2's white flying blocker cannot block Archon of Absolution because of protection from white, so it blocks the colorless flying witness instead. Archon deals ${damage} damage to P2; the witness dies.`
        : isHaunt
          ? `The ground blocker cannot block the flying Haunt. Haunt deals ${damage} damage to P2 and its lifelink gains P1 ${damage} life; an empty opponent hand prevents a discard and any resulting Haunt growth.`
          : isMenace
            ? `P2's single 3/3 blocker cannot block Tergrid because Tergrid has menace; Tergrid deals ${damage} damage to P2.`
            : `The ground blocker cannot block the flying source. It deals its printed ${damage} combat damage to P2. Equal opponent life totals keep Breena's attack trigger from firing when this is Breena.`,
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: players,
    engine: new Engine(
      { gameId, seed, players: players.map(({ config }) => config), turnCap: 4 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          lifeTotals,
          hand: [],
          battlefield,
          continueThroughCombat: true,
        },
      },
    ),
    decisionProviderOverrides: {
      P2: blockerDecisionProvider(frontName),
    },
  };
}
