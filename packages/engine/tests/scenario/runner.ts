/**
 * The scenario runner (ADR 0034 decision 10): builds a scenario file's game with
 * `strictInvariants` on, drives it only through `Engine.advance`/`Engine.submit`, answers each
 * decision from the scenario's script, and checks its expectations. A priority decision the
 * script does not act in is passed; any other decision the script does not name fails, as do an
 * unused step, a halted game and an unmet expectation. Contract tests may not import this module
 * (their evidence hashes the test closure); card tests do.
 */
import { readFileSync } from 'node:fs';
import type { DecisionRequest, GameEvent, GameResult, OracleCard } from '@mtg/shared';
import type { Engine } from '../../src/engine';
import {
  buildCardScenario,
  describeRequest,
  parseCardScenarioFile,
  scenarioAction,
  scenarioPattern,
  scenarioTargets,
  type CardScenario,
  type CardScenarioFile,
  type ScenarioStep,
} from '../../src/testing/card-scenario';
import { pinStore } from './pin-store';

const pool = JSON.parse(
  readFileSync(new URL('../../../server/fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

/** Pinned cards by name, then the committed pool for basics. Throws on a name neither holds. */
export function resolveScenarioCard(name: string): OracleCard {
  if (pinStore.has(name)) return pinStore.get(name);
  const basic = pool.find((card) => card.name === name && card.isBasicLand);
  if (basic !== undefined) return basic;
  throw new Error(
    `"${name}" is neither pinned nor a basic land; pin it with bun run pin-store add`,
  );
}

export function loadScenarioFile(url: URL): CardScenarioFile {
  return parseCardScenarioFile(JSON.parse(readFileSync(url, 'utf8')), url.pathname);
}

export interface ScenarioRun {
  engine: Engine;
  /** The decision the run stopped at, or null when the game ended. */
  stoppedAt: DecisionRequest | null;
  result: GameResult | null;
  /** Every decision submitted, with the step that answered it (null for a default pass). */
  answered: Array<{ request: DecisionRequest; step: ScenarioStep | null }>;
  /** The sequence of the first event after the arranged position. */
  firstSequence: number;
}

const MAX_DECISIONS = 2_000;

export { describeRequest };

export function runScenario(file: CardScenarioFile, scenario: CardScenario): ScenarioRun {
  const { engine } = buildCardScenario(file, scenario, resolveScenarioCard, {
    gameId: `scenario-${scenario.id}`,
    strictInvariants: true,
  });
  const firstSequence = engine.getState().eventLog.length;
  const end = scenario.end ?? 'script';
  const answered: ScenarioRun['answered'] = [];
  let next = 0;
  for (let count = 0; count < MAX_DECISIONS; count++) {
    const stepResult = engine.advance();
    if (stepResult.kind === 'gameOver') {
      const result = stepResult.result;
      if (result.halted)
        throw new Error(
          `${scenario.id}: the game halted${result.haltSite === undefined ? '' : ` at ${result.haltSite}`}: ${result.haltReason ?? ''}`,
        );
      if (next < scenario.script.length)
        throw new Error(
          `${scenario.id}: the game ended with ${scenario.script.length - next} unused step(s)`,
        );
      if (end !== 'gameOver' && end !== 'script')
        throw new Error(`${scenario.id}: the game ended before turn ${end.turn}`);
      return { engine, stoppedAt: null, result, answered, firstSequence };
    }
    if (stepResult.kind === 'continue') continue;
    const request = stepResult.request;
    const scriptDone = next >= scenario.script.length;
    if (scriptDone && request.decisionType === 'priority') {
      const stackEmpty = engine.getState().stack.length === 0;
      if (end === 'script' && stackEmpty)
        return { engine, stoppedAt: request, result: null, answered, firstSequence };
      if (typeof end === 'object' && request.turn >= end.turn)
        return { engine, stoppedAt: request, result: null, answered, firstSequence };
    }
    const step = scenario.script[next];
    const action = scenarioAction(request, step);
    if (action !== null) {
      engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(action.targets !== undefined || step!.targets !== undefined
          ? { targets: scenarioTargets(engine.getState(), request, action, step!) ?? [] }
          : {}),
      });
      answered.push({ request, step: step! });
      next += 1;
      continue;
    }
    const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
    if (request.decisionType === 'priority' && pass !== undefined) {
      engine.submit({ requestId: request.requestId, actionId: pass.id });
      answered.push({ request, step: null });
      continue;
    }
    throw new Error(
      `${scenario.id}: a decision the script does not answer${
        step === undefined ? '' : ` (next step: ${step.player} "${step.choose}")`
      }:\n${describeRequest(request)}`,
    );
  }
  throw new Error(`${scenario.id}: no end after ${MAX_DECISIONS} decisions`);
}

/** The scenario's expectations that do not hold at the end of the run. */
export function scenarioFailures(run: ScenarioRun, scenario: CardScenario): string[] {
  const state = run.engine.getState();
  const player = (id: string) => state.players.find((candidate) => candidate.id === id)!;
  const failures: string[] = [];
  const onePermanent = (name: string, controller?: string) => {
    const found = state.battlefield.filter(
      (perm) =>
        perm.name === name && (controller === undefined || perm.controllerId === controller),
    );
    if (found.length !== 1) {
      failures.push(
        `expected one ${name} on ${controller === undefined ? 'the' : `${controller}'s`} battlefield, found ${found.length}`,
      );
      return undefined;
    }
    return found[0];
  };
  const events: GameEvent[] = state.eventLog.slice(run.firstSequence);
  for (const expectation of scenario.expect) {
    if ('life' in expectation) {
      const life = player(expectation.life.player).life;
      if (life !== expectation.life.equals)
        failures.push(
          `${expectation.life.player} life is ${life}, expected ${expectation.life.equals}`,
        );
    } else if ('energy' in expectation) {
      const energy = player(expectation.energy.player).energy;
      if (energy !== expectation.energy.equals)
        failures.push(
          `${expectation.energy.player} energy is ${energy}, expected ${expectation.energy.equals}`,
        );
    } else if ('zone' in expectation) {
      const { player: id, zone, has = [], lacks = [] } = expectation.zone;
      const names =
        zone === 'battlefield'
          ? state.battlefield.filter((perm) => perm.controllerId === id).map((perm) => perm.name)
          : zone === 'exile'
            ? state.exile.filter((object) => object.ownerId === id).map((object) => object.name)
            : player(id)[zone].map((object) => object.name);
      const remaining = [...names];
      for (const name of has) {
        const index = remaining.indexOf(name);
        if (index === -1)
          failures.push(`${id}'s ${zone} lacks ${name} (has: ${names.join(', ') || 'nothing'})`);
        else remaining.splice(index, 1);
      }
      for (const name of lacks)
        if (names.includes(name)) failures.push(`${id}'s ${zone} has ${name}`);
    } else if ('counters' in expectation) {
      const { card, counter, equals, player: controller } = expectation.counters;
      const permanent = onePermanent(card, controller);
      const actual = permanent?.counters[counter] ?? 0;
      if (permanent !== undefined && actual !== equals)
        failures.push(`${card} has ${actual} ${counter} counter(s), expected ${equals}`);
    } else if ('tapped' in expectation) {
      const permanent = onePermanent(expectation.tapped.card, expectation.tapped.player);
      if (permanent !== undefined && permanent.tapped !== expectation.tapped.equals)
        failures.push(`${expectation.tapped.card} is ${permanent.tapped ? '' : 'un'}tapped`);
    } else {
      const { type, payload, count } = expectation.event;
      const matches = payload === undefined ? () => true : scenarioPattern(payload);
      const found = events.filter(
        (event) => event.type === type && matches(JSON.stringify(event.payload)),
      );
      if (count === undefined ? found.length === 0 : found.length !== count)
        failures.push(
          `expected ${count ?? 'some'} ${type} event(s)${payload === undefined ? '' : ` matching ${payload}`}, found ${found.length}`,
        );
    }
  }
  return failures;
}
