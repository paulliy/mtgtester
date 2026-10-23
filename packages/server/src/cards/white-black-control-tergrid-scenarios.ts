import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine } from '@mtg/engine';
import type { DecisionProvider } from '@mtg/engine';
import type { GameId, OracleCard, PlayerId } from '@mtg/shared';
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

const tergrid = fromPin("Tergrid, God of Fright // Tergrid's Lantern");
const duress = fromPin('Duress');
const solRing = fromPin('Sol Ring');
const liliana = fromPin('Liliana of the Veil');
const mother = fromPin('Mother of Runes');
const plains = fromPin('Plains').card;
const swamp = fromPin('Swamp').card;

const entries = [
  {
    id: 'tergrid-front-viewer-discards-permanent-card',
    source: tergrid,
    title: 'Tergrid: normal front-face cast returns a permanent discarded by Duress',
    clauseIds: ['tergrid-god-of-fright-tergrid-s-lantern-c02'],
    kind: 'discard' as const,
  },
  {
    id: 'tergrid-front-viewer-opponent-sacrifice',
    source: tergrid,
    title: 'Tergrid: P2 sacrifices a creature to Liliana and Tergrid may return it',
    clauseIds: ['tergrid-god-of-fright-tergrid-s-lantern-c02'],
    kind: 'sacrifice' as const,
  },
  {
    id: 'tergrid-lantern-viewer-discard-then-paid-untap',
    source: tergrid,
    title: "Tergrid's Lantern: P2 discards, then pay {3}{B} to untap it",
    clauseIds: [
      'tergrid-god-of-fright-tergrid-s-lantern-c03',
      'tergrid-god-of-fright-tergrid-s-lantern-c04',
    ],
    kind: 'lantern' as const,
  },
] as const;

export const WHITE_BLACK_TERGRID_SCENARIO_IDS = entries.map((entry) => entry.id);

function makeSeats(cards: Record<PlayerId, OracleCard[]>, suffix: string) {
  return (['P1', 'P2', 'P3', 'P4'] as const).map((seat) => {
    const deckCards = cards[seat];
    if (deckCards === undefined) throw new Error(`Missing ${seat} deck for ${suffix}`);
    const config = {
      id: seat,
      deckId: `white-black-tergrid-${suffix}-${seat}`,
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

function p2LilianaProvider(): DecisionProvider {
  let activated = false;
  return {
    decide(request) {
      if (
        request.decidingPlayer === 'P2' &&
        request.activePlayer === 'P2' &&
        request.phase === 'precombatMain' &&
        request.decisionType === 'priority' &&
        !activated
      ) {
        const action = request.legalActions.find(
          (candidate) =>
            candidate.type === 'activateAbility' &&
            candidate.description.includes('Liliana of the Veil') &&
            candidate.description.includes('sacrifices a creature'),
        );
        if (action !== undefined) {
          activated = true;
          const targets = (action.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: slot.options.includes('P2' as PlayerId) ? ('P2' as PlayerId) : slot.options[0]!,
          }));
          return {
            requestId: request.requestId,
            actionId: action.id,
            ...(targets.length > 0 ? { targets } : {}),
          };
        }
      }
      if (
        request.decidingPlayer === 'P2' &&
        request.decisionType === 'general' &&
        request.prompt === 'Sacrifice a creature.'
      ) {
        const action = request.legalActions.find((candidate) =>
          candidate.description.includes(mother.card.name),
        );
        if (action === undefined) throw new Error('Liliana did not offer P2’s Mother of Runes');
        return { requestId: request.requestId, actionId: action.id };
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function p2LanternChoiceProvider(): DecisionProvider {
  return {
    decide(request) {
      if (
        request.decidingPlayer === 'P2' &&
        request.decisionType === 'general' &&
        request.prompt === 'Lose life unless you sacrifice a nonland permanent or discard a card.'
      ) {
        const discard = request.legalActions.find((action) =>
          /^Discard a card$/i.test(action.description),
        );
        if (discard === undefined) throw new Error('Lantern did not offer P2 the discard option');
        return { requestId: request.requestId, actionId: discard.id };
      }
      if (
        request.decidingPlayer === 'P2' &&
        request.decisionType === 'general' &&
        request.prompt.startsWith('Discard a card')
      ) {
        const action = request.legalActions[0];
        if (action === undefined) throw new Error('P2 has no card to discard for Lantern');
        return { requestId: request.requestId, actionId: action.id };
      }
      const action =
        request.legalActions.find((candidate) => candidate.type === 'pass') ??
        request.legalActions[0];
      if (action === undefined) throw new Error(`No legal P2 action for ${request.decisionType}`);
      return { requestId: request.requestId, actionId: action.id };
    },
  };
}

function build(id: string, gameId: GameId): CardTestScenario {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown white-black-control Tergrid scenario ${id}`);

  if (entry.kind === 'discard') {
    const configs = makeSeats(
      {
        P1: [
          entry.source.card,
          duress.card,
          ...Array.from({ length: 3 }, () => plains),
          ...Array.from({ length: 3 }, () => swamp),
        ],
        P2: [solRing.card, ...Array.from({ length: 10 }, () => plains)],
        P3: Array.from({ length: 10 }, () => plains),
        P4: Array.from({ length: 10 }, () => plains),
      },
      entry.id,
    );
    const seed = `card-lab-${id}-v1`;
    const engine = new Engine(
      { gameId, seed, players: configs.map(({ config }) => config), turnCap: 5 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 2,
          hand: [
            { playerId: 'P1', cardNames: [entry.source.card.name, duress.card.name] },
            { playerId: 'P2', cardNames: [solRing.card.name] },
          ],
          battlefield: [
            { playerId: 'P1', cardNames: [plains.name, plains.name, plains.name] },
            { playerId: 'P1', cardNames: [swamp.name, swamp.name, swamp.name] },
          ],
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'Normally cast Tergrid, God of Fright from your hand for {3}{B}{B}.',
          'Normally cast Duress targeting P2 and choose the real Sol Ring from P2’s revealed hand.',
          'Accept Tergrid’s optional trigger to put that discarded permanent onto the battlefield under your control.',
        ],
        expectedOutcome:
          'Duress makes P2 discard the real Sol Ring. Tergrid’s optional trigger returns that artifact card from P2’s graveyard to the battlefield under P1’s control.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed,
      seats: configs,
      engine,
    };
  }

  if (entry.kind === 'sacrifice') {
    const configs = makeSeats(
      {
        P1: [entry.source.card],
        P2: [liliana.card, mother.card],
        P3: Array.from({ length: 10 }, () => plains),
        P4: Array.from({ length: 10 }, () => plains),
      },
      entry.id,
    );
    const seed = `card-lab-${id}-v1`;
    const engine = new Engine(
      { gameId, seed, players: configs.map(({ config }) => config), turnCap: 5 },
      {
        preparedScenario: {
          currentTurnPlayer: 'P2',
          phase: 'precombatMain',
          step: null,
          turnNumber: 4,
          hand: [],
          battlefield: [
            { playerId: 'P1', cardNames: [entry.source.card.name] },
            { playerId: 'P2', cardNames: [liliana.card.name, mother.card.name] },
          ],
        },
      },
    );
    return {
      metadata: {
        id,
        version: 1,
        title: entry.title,
        instructions: [
          'P2 normally activates Liliana of the Veil’s -2 loyalty ability targeting P2.',
          'P2 chooses the real Mother of Runes to sacrifice. Accept Tergrid’s optional trigger to return it under your control.',
        ],
        expectedOutcome:
          'Liliana’s legal -2 activation causes P2 to sacrifice a nontoken creature. Tergrid’s optional trigger returns the sacrificed Mother of Runes from P2’s graveyard to the battlefield under P1’s control.',
        oracleSha256: entry.source.sha256,
        clauseIds: [...entry.clauseIds],
      },
      seed,
      seats: configs,
      engine,
      decisionProviderOverrides: { P2: p2LilianaProvider() },
    };
  }

  const configs = makeSeats(
    {
      P1: [entry.source.card, swamp, swamp, ...Array.from({ length: 6 }, () => plains)],
      P2: [mother.card, swamp, ...Array.from({ length: 10 }, () => plains)],
      P3: Array.from({ length: 10 }, () => plains),
      P4: Array.from({ length: 10 }, () => plains),
    },
    entry.id,
  );
  const seed = `card-lab-${id}-v1`;
  const engine = new Engine(
    { gameId, seed, players: configs.map(({ config }) => config), turnCap: 4 },
    {
      preparedScenario: {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [
          { playerId: 'P1', cardNames: [entry.source.card.name] },
          { playerId: 'P2', cardNames: [swamp.name] },
        ],
        battlefield: [
          {
            playerId: 'P1',
            cardNames: [...Array.from({ length: 6 }, () => plains.name), swamp.name, swamp.name],
          },
          { playerId: 'P2', cardNames: [mother.card.name] },
        ],
      },
    },
  );
  return {
    metadata: {
      id,
      version: 1,
      title: entry.title,
      instructions: [
        "Cast Tergrid's Lantern from the back face for {3}{B}.",
        'Activate its {T} ability targeting P2. P2 has a real card in hand and a nonland permanent, and chooses to discard the Swamp rather than lose life.',
        "Before passing the turn, activate the real {3}{B} ability using your other four lands to untap Tergrid's Lantern.",
      ],
      expectedOutcome:
        "P2 chooses to discard a real Swamp card, so P2 loses no life and the Lantern's {T} ability leaves it tapped. P1 then pays {3}{B} from the other four lands for the second activated ability, which untaps the Lantern.",
      oracleSha256: entry.source.sha256,
      clauseIds: [...entry.clauseIds],
    },
    seed,
    seats: configs,
    engine,
    decisionProviderOverrides: { P2: p2LanternChoiceProvider() },
  };
}

export function whiteBlackControlTergridScenario(id: string, gameId: GameId): CardTestScenario {
  return build(id, gameId);
}
