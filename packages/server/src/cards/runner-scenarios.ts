/**
 * Card Test Lab scenarios from the scenario files the engine tests run (ADR 0034 decision 10):
 * the same position, cards and script, so a scenario is written once. P1 is the viewer, who plays
 * the script's P1 steps by hand; every other seat answers its own script steps in order, passes
 * priority otherwise, and takes its first legal action for any other choice, as lab bots do.
 * Scenario IDs come from the files, so there is no hand-kept list to drift.
 */
import { readFileSync } from 'node:fs';
import {
  CARD_SCENARIO_SEATS,
  buildCardScenario,
  parseCardScenarioFile,
  scenarioAction,
  scenarioTargets,
  type CardScenario,
  type CardScenarioFile,
} from '@mtg/engine';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

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
const pool = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

function resolveCard(name: string): OracleCard {
  const sha = store.names[name];
  if (sha !== undefined) return store.cards[sha]!;
  const basic = pool.find((card) => card.name === name && card.isBasicLand);
  if (basic !== undefined) return basic;
  throw new Error(`Scenario card "${name}" is neither pinned nor a basic land`);
}

const scenarioFile = (name: string, text: string): CardScenarioFile =>
  parseCardScenarioFile(JSON.parse(text), `engine/tests/scenarios/${name}`);

/**
 * Every scenario file, each read through its own literal path so viewer evidence binds its bytes.
 * `card:finish` adds a line here; `runner-scenarios.test.ts` checks it against the directory.
 */
export const RUNNER_SCENARIO_FILES: ReadonlyArray<{ name: string; file: CardScenarioFile }> = [
  {
    name: 'abraded-bluffs.json',
    file: scenarioFile(
      'abraded-bluffs.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/abraded-bluffs.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'academy-manufactor.json',
    file: scenarioFile(
      'academy-manufactor.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/academy-manufactor.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'adventurous-impulse.json',
    file: scenarioFile(
      'adventurous-impulse.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/adventurous-impulse.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'aetherize.json',
    file: scenarioFile(
      'aetherize.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/aetherize.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'arcbound-worker.json',
    file: scenarioFile(
      'arcbound-worker.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/arcbound-worker.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'braids-arisen-nightmare.json',
    file: scenarioFile(
      'braids-arisen-nightmare.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/braids-arisen-nightmare.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'burglar-rat.json',
    file: scenarioFile(
      'burglar-rat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/burglar-rat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'chrome-mox.json',
    file: scenarioFile(
      'chrome-mox.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/chrome-mox.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'craterhoof-behemoth.json',
    file: scenarioFile(
      'craterhoof-behemoth.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/craterhoof-behemoth.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'electrickery.json',
    file: scenarioFile(
      'electrickery.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/electrickery.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'ettercap.json',
    file: scenarioFile(
      'ettercap.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ettercap.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'everflowing-chalice.json',
    file: scenarioFile(
      'everflowing-chalice.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/everflowing-chalice.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'faerie-mastermind.json',
    file: scenarioFile(
      'faerie-mastermind.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/faerie-mastermind.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'fervent-charge.json',
    file: scenarioFile(
      'fervent-charge.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/fervent-charge.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'finale-of-devastation.json',
    file: scenarioFile(
      'finale-of-devastation.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/finale-of-devastation.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'flusterstorm.json',
    file: scenarioFile(
      'flusterstorm.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/flusterstorm.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'fog.json',
    file: scenarioFile(
      'fog.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/fog.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'forbidden-alchemy.json',
    file: scenarioFile(
      'forbidden-alchemy.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/forbidden-alchemy.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'glimpse-the-unthinkable.json',
    file: scenarioFile(
      'glimpse-the-unthinkable.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/glimpse-the-unthinkable.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'gonti-lord-of-luxury.json',
    file: scenarioFile(
      'gonti-lord-of-luxury.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/gonti-lord-of-luxury.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'grim-monolith.json',
    file: scenarioFile(
      'grim-monolith.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/grim-monolith.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'gudul-lurker.json',
    file: scenarioFile(
      'gudul-lurker.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/gudul-lurker.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'hooded-hydra.json',
    file: scenarioFile(
      'hooded-hydra.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/hooded-hydra.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'hunted-bonebrute.json',
    file: scenarioFile(
      'hunted-bonebrute.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/hunted-bonebrute.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'innocuous-rat.json',
    file: scenarioFile(
      'innocuous-rat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/innocuous-rat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'inspiring-call.json',
    file: scenarioFile(
      'inspiring-call.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/inspiring-call.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mana-geyser.json',
    file: scenarioFile(
      'mana-geyser.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mana-geyser.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mithril-coat.json',
    file: scenarioFile(
      'mithril-coat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mithril-coat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mizzium-mortars.json',
    file: scenarioFile(
      'mizzium-mortars.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/mizzium-mortars.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'monastery-swiftspear.json',
    file: scenarioFile(
      'monastery-swiftspear.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/monastery-swiftspear.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'mox-diamond.json',
    file: scenarioFile(
      'mox-diamond.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mox-diamond.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'myr-convert.json',
    file: scenarioFile(
      'myr-convert.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/myr-convert.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'nantuko-vigilante.json',
    file: scenarioFile(
      'nantuko-vigilante.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/nantuko-vigilante.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'noble-hierarch.json',
    file: scenarioFile(
      'noble-hierarch.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/noble-hierarch.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'orcish-bowmasters.json',
    file: scenarioFile(
      'orcish-bowmasters.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/orcish-bowmasters.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'path-to-exile.json',
    file: scenarioFile(
      'path-to-exile.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/path-to-exile.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'phyrexian-metamorph.json',
    file: scenarioFile(
      'phyrexian-metamorph.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/phyrexian-metamorph.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'plea-for-power.json',
    file: scenarioFile(
      'plea-for-power.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/plea-for-power.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'praetors-grasp.json',
    file: scenarioFile(
      'praetors-grasp.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/praetors-grasp.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'professional-face-breaker.json',
    file: scenarioFile(
      'professional-face-breaker.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/professional-face-breaker.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ragavan-nimble-pilferer.json',
    file: scenarioFile(
      'ragavan-nimble-pilferer.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/ragavan-nimble-pilferer.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'razortrap-gorge.json',
    file: scenarioFile(
      'razortrap-gorge.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/razortrap-gorge.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ruby-medallion.json',
    file: scenarioFile(
      'ruby-medallion.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ruby-medallion.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'seedborn-muse.json',
    file: scenarioFile(
      'seedborn-muse.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/seedborn-muse.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'shadowspear.json',
    file: scenarioFile(
      'shadowspear.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/shadowspear.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'simic-growth-chamber.json',
    file: scenarioFile(
      'simic-growth-chamber.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/simic-growth-chamber.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'souls-attendant.json',
    file: scenarioFile(
      'souls-attendant.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/souls-attendant.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'sun-titan.json',
    file: scenarioFile(
      'sun-titan.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sun-titan.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'sylvan-library.json',
    file: scenarioFile(
      'sylvan-library.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sylvan-library.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'takenuma-abandoned-mire.json',
    file: scenarioFile(
      'takenuma-abandoned-mire.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/takenuma-abandoned-mire.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'the-ozolith.json',
    file: scenarioFile(
      'the-ozolith.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/the-ozolith.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'thief-of-sanity.json',
    file: scenarioFile(
      'thief-of-sanity.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/thief-of-sanity.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'thraben-inspector.json',
    file: scenarioFile(
      'thraben-inspector.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/thraben-inspector.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'urzas-incubator.json',
    file: scenarioFile(
      'urzas-incubator.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/urzas-incubator.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'vivid-creek.json',
    file: scenarioFile(
      'vivid-creek.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/vivid-creek.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'witch-enchanter.json',
    file: scenarioFile(
      'witch-enchanter.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/witch-enchanter.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
];
const FILES = RUNNER_SCENARIO_FILES.map(({ file }) => file);

/** Every runner scenario, for the lab's picker and the viewer spec. */
export const RUNNER_SCENARIOS = FILES.flatMap((file) =>
  file.scenarios.map(({ id, title }) => ({ id, cardName: file.card, title })),
);

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Clause ids for the Oracle lines a scenario exercises. */
export function runnerClauseIds(cardName: string, lines: readonly number[]): string[] {
  return lines.map((line) => `${slug(cardName)}-clause-${line}`);
}

/** A non-viewer seat that answers its script steps, in order, and otherwise plays it safe. */
function scriptedSeat(seat: PlayerId, scenario: CardScenario, engine: () => Engine) {
  const steps = scenario.script.filter((step) => step.player === seat);
  let next = 0;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const step = steps[next];
      const action = scenarioAction(request, step);
      if (action !== null && step !== undefined) {
        next += 1;
        const targets = scenarioTargets(engine().getState(), request, action, step);
        return {
          requestId: request.requestId,
          actionId: action.id,
          ...(targets !== undefined && { targets }),
        };
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      const fallback = pass ?? request.legalActions[0]!;
      return {
        requestId: request.requestId,
        actionId: fallback.id,
        ...(fallback.targets !== undefined && {
          targets: fallback.targets.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! })),
        }),
      };
    },
  };
}

export function runnerScenario(id: string, gameId: GameId): CardTestScenario {
  for (const file of FILES) {
    const scenario = file.scenarios.find((candidate) => candidate.id === id);
    if (scenario === undefined) continue;
    const built = buildCardScenario(file, scenario, resolveCard, { gameId });
    const engine = built.engine;
    const sha = store.names[file.card];
    if (sha === undefined) throw new Error(`Scenario card ${file.card} is not pinned`);
    return {
      metadata: {
        id,
        version: 1,
        title: scenario.title,
        instructions: scenario.instructions,
        expectedOutcome: scenario.expectedOutcome,
        oracleSha256: sha,
        clauseIds: runnerClauseIds(file.card, scenario.clauses),
      },
      seed: built.seed,
      seats: built.players.map((config) => ({
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
      decisionProviderOverrides: Object.fromEntries(
        CARD_SCENARIO_SEATS.filter((seat) => seat !== 'P1').map((seat) => [
          seat,
          scriptedSeat(seat, scenario, () => engine),
        ]),
      ),
    };
  }
  throw new Error(`Unknown runner scenario ${id}`);
}
