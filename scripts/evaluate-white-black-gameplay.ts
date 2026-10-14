import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { HeuristicDecisionProvider } from '../packages/bot/src/index';
import { Engine, RandomDecisionProvider } from '../packages/engine/src/index';
import type { EnginePlayerConfig } from '../packages/engine/src/index';
import type {
  DecisionResponse,
  GameId,
  LegalAction,
  PlayerId,
  OracleCard,
} from '../packages/shared/src/index';
import { createCardTestScenario } from '../packages/server/src/cards/card-test-scenarios';
import { WHITE_BLACK_COMBAT_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-combat-scenarios';
import { WHITE_BLACK_HAND_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-hand-scenarios';
import { WHITE_BLACK_ENTRY_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-entry-scenarios';
import { WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-discard-extension-scenarios';
import { WHITE_BLACK_DEFENDER_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-defender-scenarios';
import { WHITE_BLACK_SPELL_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-spell-scenarios';
import { WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-counter-class-scenarios';
import { WHITE_BLACK_FINAL_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-final-scenarios';
import { WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-perch-scenarios';
import { WHITE_BLACK_PROTECTION_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-protection-scenarios';
import { WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-discard-core-scenarios';
import { WHITE_BLACK_GRAVEYARD_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-graveyard-scenarios';
import { WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-stax-scenarios';
import { WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-replacements-scenarios';
import { WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-liliana-scenarios';
import { WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-remaining-combat-scenarios';
import { WHITE_BLACK_TERGRID_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-tergrid-scenarios';
import { WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-hand-limit-scenarios';
import { WHITE_BLACK_KEYWORD_SCENARIO_IDS } from '../packages/server/src/cards/white-black-control-keyword-scenarios';

const preparedOnly = process.argv.includes('--prepared-only');
const OUTPUT = preparedOnly
  ? '.tmp/white-black-prepared-ai.json'
  : 'docs/reviews/white-black-control-gameplay-ai.json';
const DECISION_CAP = 2_000;
const FULL_POD_TURN_CAP = 160;
const FULL_POD_DECISION_CAP = 12_000;
const CORE_SCENARIO_IDS = [
  ...WHITE_BLACK_COMBAT_SCENARIO_IDS,
  ...WHITE_BLACK_HAND_SCENARIO_IDS,
  ...WHITE_BLACK_ENTRY_SCENARIO_IDS,
  ...WHITE_BLACK_DISCARD_EXTENSION_SCENARIO_IDS,
  ...WHITE_BLACK_DEFENDER_SCENARIO_IDS,
  ...WHITE_BLACK_SPELL_SCENARIO_IDS,
  ...WHITE_BLACK_COUNTER_CLASS_SCENARIO_IDS,
  ...WHITE_BLACK_FINAL_SCENARIO_IDS,
  ...WHITE_BLACK_CONTROL_PERCH_SCENARIO_IDS,
  ...WHITE_BLACK_PROTECTION_SCENARIO_IDS,
  ...WHITE_BLACK_DISCARD_CORE_SCENARIO_IDS,
  ...WHITE_BLACK_GRAVEYARD_SCENARIO_IDS,
  ...WHITE_BLACK_CONTROL_STAX_SCENARIO_IDS,
  ...WHITE_BLACK_REPLACEMENTS_SCENARIO_IDS,
  ...WHITE_BLACK_CONTROL_LILIANA_SCENARIO_IDS,
  ...WHITE_BLACK_REMAINING_COMBAT_SCENARIO_IDS,
  ...WHITE_BLACK_TERGRID_SCENARIO_IDS,
  ...WHITE_BLACK_HAND_LIMIT_SCENARIO_IDS,
  ...WHITE_BLACK_KEYWORD_SCENARIO_IDS,
];
const SCENARIO_IDS = [...new Set(CORE_SCENARIO_IDS)];

type ProviderKind = 'random' | 'heuristic';
type Observation = {
  decision: number;
  actor: string;
  actionType: string;
  description: string;
};
const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

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

function buildFullPodPlayers(): {
  players: EnginePlayerConfig[];
  oracleSha256: string;
  deckSha256: string;
} {
  const oraclePath = 'packages/engine/tests/fixtures/white-black-control-oracle.json';
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8')) as {
    cards: Array<{ sha256: string; card: OracleCard }>;
  };
  const byName = new Map(oracle.cards.map((entry) => [entry.card.name, entry]));
  const findPinned = (name: string) => {
    const entry = byName.get(name);
    if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
    const actualHash = createHash('sha256').update(canonical(entry.card)).digest('hex');
    if (actualHash !== entry.sha256) throw new Error(`Pinned Oracle hash mismatch: ${name}`);
    return entry.card;
  };
  const deckText = readFileSync(
    'packages/server/fixtures/coverage-decks/white-black-control.txt',
    'utf8',
  );
  const mainLines = deckText
    .split(/\r?\n/)
    .slice(deckText.split(/\r?\n/).findIndex((line) => line.trim() === 'Deck') + 1);
  const cards = mainLines.flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match === null) return [];
    const quantity = Number(match[1]);
    const name = match[2]!;
    return Array.from({ length: quantity }, () => findPinned(name));
  });
  const commander = findPinned('Breena, the Demagogue');
  if (cards.length !== 99) throw new Error(`Expected 99 main-deck cards, found ${cards.length}`);
  const players: EnginePlayerConfig[] = (['P1', 'P2', 'P3', 'P4'] as const).map((id, index) => ({
    id,
    deckId: `white-black-control-fullpod-${index + 1}`,
    commanders: [commander],
    cards: [...cards],
  }));
  const deckOracleSha256 = sha256({
    commander: createHash('sha256').update(canonical(commander)).digest('hex'),
    main: cards.map((card) => createHash('sha256').update(canonical(card)).digest('hex')),
  });
  return {
    players,
    oracleSha256: deckOracleSha256,
    deckSha256: createHash('sha256').update(deckText).digest('hex'),
  };
}

function runFullPod(
  kind: ProviderKind,
  players: EnginePlayerConfig[],
  deckEvidence: { oracleSha256: string; deckSha256: string },
) {
  process.stdout.write(`Starting ${kind} full pod\n`);
  const seed = `white-black-control-fullpod-seed-1-${kind}`;
  const engine = new Engine({
    gameId: `white-black-fullpod-${kind}` as GameId,
    seed,
    players,
    turnCap: FULL_POD_TURN_CAP,
  });
  const scenarioSha256 = sha256({
    oracleSha256: deckEvidence.oracleSha256,
    deckSha256: deckEvidence.deckSha256,
    seed,
    initialState: engine.getState(),
  });
  const random = new RandomDecisionProvider(`${seed}-random`);
  const heuristics = new Map<PlayerId, HeuristicDecisionProvider>();
  const observations: Array<{
    decision: number;
    turn: number;
    actor: string;
    actionType: string;
    description: string;
  }> = [];
  const subjectCount = (actionType: string) =>
    observations.filter(
      (entry) =>
        entry.actor === 'P1' &&
        entry.actionType === actionType &&
        entry.description.includes('Breena'),
    ).length;
  try {
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        const result = step.result;
        return {
          provider: kind,
          seed,
          status: result.halted ? ('failed' as const) : ('completed' as const),
          end: result.halted ? 'halted' : 'game-over',
          turnCount: result.turnCount,
          decisions: observations.length,
          casts: observations.filter((entry) => entry.actionType === 'castSpell').length,
          activations: observations.filter((entry) => entry.actionType === 'activateAbility')
            .length,
          subjectCasts: subjectCount('castSpell'),
          subjectActivations: subjectCount('activateAbility'),
          usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
          observations,
          scenarioSha256,
          ...(result.haltReason !== undefined ? { error: result.haltReason } : {}),
        };
      }
      if (step.kind === 'continue') continue;
      if (observations.length >= FULL_POD_DECISION_CAP) {
        return {
          provider: kind,
          seed,
          status: 'failed' as const,
          end: 'decision-cap',
          turnCount: step.request.turn,
          decisions: observations.length,
          casts: observations.filter((entry) => entry.actionType === 'castSpell').length,
          activations: observations.filter((entry) => entry.actionType === 'activateAbility')
            .length,
          subjectCasts: subjectCount('castSpell'),
          subjectActivations: subjectCount('activateAbility'),
          usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
          observations,
          scenarioSha256,
          error: `decision cap exceeded (${FULL_POD_DECISION_CAP})`,
        };
      }
      const request = step.request;
      let response: DecisionResponse;
      if (kind === 'heuristic') {
        let provider = heuristics.get(request.decidingPlayer);
        if (provider === undefined) {
          provider = new HeuristicDecisionProvider(
            `${seed}-heuristic-${request.decidingPlayer}`,
            () => engine.view(request.decidingPlayer),
          );
          heuristics.set(request.decidingPlayer, provider);
        }
        response = provider.decide(request);
      } else {
        response = random.decide(request);
      }
      const chosen = request.legalActions.find((action) => action.id === response.actionId);
      if (chosen === undefined)
        throw new Error(
          `provider returned an unknown action at decision ${observations.length + 1}`,
        );
      observations.push({
        decision: observations.length + 1,
        turn: request.turn,
        actor: request.decidingPlayer,
        actionType: chosen.type,
        description: chosen.description,
      });
      engine.submit(response);
      if (observations.length % 100 === 0)
        process.stdout.write(`${kind}: turn ${request.turn}, ${observations.length} decisions\n`);
    }
  } catch (error) {
    return {
      provider: kind,
      seed,
      status: 'failed' as const,
      end: 'error',
      turnCount: engine.getState().turnNumber,
      decisions: observations.length,
      casts: observations.filter((entry) => entry.actionType === 'castSpell').length,
      activations: observations.filter((entry) => entry.actionType === 'activateAbility').length,
      subjectCasts: subjectCount('castSpell'),
      subjectActivations: subjectCount('activateAbility'),
      usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
      observations,
      scenarioSha256,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runScenario(scenarioId: string, kind: ProviderKind) {
  const runId = `white-black-gameplay-${kind}-${scenarioId}`;
  let seed = 'unavailable';
  let subject = scenarioId;
  let scenarioSha256: string | undefined;
  const observations: Observation[] = [];
  const subjectCount = (type: string) =>
    observations.filter(
      (entry) =>
        entry.actor === 'P1' && entry.actionType === type && entry.description.includes(subject),
    ).length;
  try {
    const scenario = createCardTestScenario(scenarioId, runId as GameId);
    if (scenario === null) throw new Error(`unknown scenario: ${scenarioId}`);
    subject = scenario.metadata.title.split(':', 1)[0] ?? scenarioId;
    seed = `${scenario.seed}-${kind}-observer`;
    scenarioSha256 = sha256({
      metadata: scenario.metadata,
      seed: scenario.seed,
      initialState: scenario.engine.getState(),
    });
    const engine = scenario.engine;
    const random = new RandomDecisionProvider(`${seed}-random`);
    const heuristics = new Map<PlayerId, HeuristicDecisionProvider>();
    const heuristicFor = (playerId: PlayerId) => {
      let provider = heuristics.get(playerId);
      if (provider === undefined) {
        provider = new HeuristicDecisionProvider(`${seed}-heuristic-${playerId}`, () =>
          engine.view(playerId),
        );
        heuristics.set(playerId, provider);
      }
      return provider;
    };
    let decisions = 0;
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'gameOver') {
        const actionCounts = (type: string) =>
          observations.filter((entry) => entry.actionType === type).length;
        return {
          provider: kind,
          seed,
          status: 'completed' as const,
          decisions,
          casts: actionCounts('castSpell'),
          activations: actionCounts('activateAbility'),
          subjectCasts: subjectCount('castSpell'),
          subjectActivations: subjectCount('activateAbility'),
          usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
          observations,
          ...(scenarioSha256 !== undefined ? { scenarioSha256 } : {}),
        };
      }
      if (step.kind === 'continue') continue;
      decisions += 1;
      if (decisions > DECISION_CAP) {
        return {
          provider: kind,
          seed,
          status: 'failed' as const,
          decisions,
          casts: observations.filter((entry) => entry.actionType === 'castSpell').length,
          activations: observations.filter((entry) => entry.actionType === 'activateAbility')
            .length,
          subjectCasts: subjectCount('castSpell'),
          subjectActivations: subjectCount('activateAbility'),
          usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
          observations,
          scenarioSha256,
          error: `decision cap exceeded (${DECISION_CAP})`,
        };
      }
      const request = step.request;
      const response: DecisionResponse =
        kind === 'heuristic'
          ? heuristicFor(request.decidingPlayer).decide(request)
          : random.decide(request);
      const chosen: LegalAction | undefined = request.legalActions.find(
        (action) => action.id === response.actionId,
      );
      if (chosen === undefined)
        throw new Error(`provider returned an unknown action at decision ${decisions}`);
      observations.push({
        decision: decisions,
        actor: request.decidingPlayer,
        actionType: chosen.type,
        description: chosen.description,
      });
      engine.submit(response);
    }
  } catch (error) {
    return {
      provider: kind,
      seed,
      status: 'failed' as const,
      decisions: observations.length,
      casts: observations.filter((entry) => entry.actionType === 'castSpell').length,
      activations: observations.filter((entry) => entry.actionType === 'activateAbility').length,
      subjectCasts: subjectCount('castSpell'),
      subjectActivations: subjectCount('activateAbility'),
      usedSubjectCard: subjectCount('castSpell') + subjectCount('activateAbility') > 0,
      observations,
      ...(scenarioSha256 !== undefined ? { scenarioSha256 } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sourceTreeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceTreeFiles(path);
    return path.endsWith('.ts') ? [path.replaceAll('\\', '/')] : [];
  });
}

const sourceFiles = [
  ...new Set([
    'scripts/evaluate-white-black-gameplay.ts',
    'packages/server/src/cards/card-test-scenarios.ts',
    'packages/server/src/cards/white-black-control-combat-scenarios.ts',
    'packages/server/src/cards/white-black-control-hand-scenarios.ts',
    'packages/server/src/cards/white-black-control-entry-scenarios.ts',
    'packages/server/src/cards/white-black-control-discard-extension-scenarios.ts',
    'packages/server/src/cards/white-black-control-defender-scenarios.ts',
    'packages/server/src/cards/white-black-control-spell-scenarios.ts',
    'packages/server/src/cards/white-black-control-counter-class-scenarios.ts',
    'packages/server/src/cards/white-black-control-final-scenarios.ts',
    'packages/server/src/cards/white-black-control-perch-scenarios.ts',
    'packages/server/src/cards/white-black-control-protection-scenarios.ts',
    'packages/server/src/cards/white-black-control-discard-core-scenarios.ts',
    'packages/server/src/cards/white-black-control-graveyard-scenarios.ts',
    'packages/server/src/cards/white-black-control-stax-scenarios.ts',
    'packages/server/src/cards/white-black-control-replacements-scenarios.ts',
    'packages/server/src/cards/white-black-control-liliana-scenarios.ts',
    'packages/server/src/cards/white-black-control-remaining-combat-scenarios.ts',
    'packages/server/src/cards/white-black-control-tergrid-scenarios.ts',
    'packages/server/src/cards/white-black-control-hand-limit-scenarios.ts',
    'packages/server/src/cards/white-black-control-keyword-scenarios.ts',
    'packages/engine/tests/fixtures/white-black-control-oracle.json',
    'packages/server/fixtures/coverage-decks/white-black-control.txt',
    ...sourceTreeFiles('packages/engine/src'),
    ...sourceTreeFiles('packages/bot/src'),
    ...sourceTreeFiles('packages/shared/src'),
  ]),
];
const files = Object.fromEntries(
  sourceFiles.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
const gitHead = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
}).trim();

const scenarios = SCENARIO_IDS.map((scenarioId) => {
  try {
    const scenario = createCardTestScenario(scenarioId, `white-black-hash-${scenarioId}` as GameId);
    if (scenario === null) throw new Error(`unknown scenario: ${scenarioId}`);
    const scenarioSha256 = sha256({
      metadata: scenario.metadata,
      seed: scenario.seed,
      initialState: scenario.engine.getState(),
    });
    const subject = scenario.metadata.title.split(':', 1)[0] ?? scenarioId;
    return {
      scenarioId,
      subject,
      oracleSha256: scenario.metadata.oracleSha256,
      scenarioSha256,
      runs: [runScenario(scenarioId, 'random'), runScenario(scenarioId, 'heuristic')],
    };
  } catch (error) {
    return {
      scenarioId,
      subject: scenarioId,
      oracleSha256: null,
      scenarioSha256: null,
      error: error instanceof Error ? error.message : String(error),
      runs: [runScenario(scenarioId, 'random'), runScenario(scenarioId, 'heuristic')],
    };
  }
});

let fullPod: Record<string, unknown>;
if (preparedOnly) {
  fullPod = {
    status: 'not-run',
    reason: 'Prepared-only evaluation; full-pod observations are recorded separately.',
  };
} else
  try {
    const deckEvidence = buildFullPodPlayers();
    fullPod = {
      deck: 'white-black-control.txt',
      commander: 'Breena, the Demagogue',
      mainDeckCardCount: 99,
      podSize: 4,
      oracleSha256: deckEvidence.oracleSha256,
      deckSha256: deckEvidence.deckSha256,
      turnCap: FULL_POD_TURN_CAP,
      decisionCap: FULL_POD_DECISION_CAP,
      runs: [
        runFullPod('random', deckEvidence.players, deckEvidence),
        runFullPod('heuristic', deckEvidence.players, deckEvidence),
      ],
    };
  } catch (error) {
    fullPod = {
      deck: 'white-black-control.txt',
      commander: 'Breena, the Demagogue',
      mainDeckCardCount: 99,
      podSize: 4,
      turnCap: FULL_POD_TURN_CAP,
      decisionCap: FULL_POD_DECISION_CAP,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/evaluate-white-black-gameplay.ts',
  evidenceKind: 'gameplay-ai-quality-observations',
  liveLlm: 'not-run',
  qualityOnly: true,
  rulesCertification: false,
  workspaceRevision: {
    label: 'mutable-development-observations',
    gitHead,
    sourceSha256: sha256(files),
    files,
  },
  decisionCap: DECISION_CAP,
  providers: ['random', 'heuristic-all-players'],
  note: 'Quality-only observations from production-engine prepared scenarios using seeded random and heuristic providers for every player, without scripted scenario decision overrides. These observations do not certify rules or viewer correctness. Failed runs retain their observed actions and error; live LLM was not run.',
  scenarios,
  fullPod,
};

writeFileSync(resolve(OUTPUT), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output: OUTPUT, scenarioCount: scenarios.length })}\n`);
