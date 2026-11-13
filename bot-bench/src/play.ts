/**
 * Plays one case through the real engine. The position is arranged by the engine's scenario
 * builder, scripted up to the decision under test, then one `Actor` answers for the seat under
 * test while every other decision is answered by the case's table (a script, then the heuristic
 * bot). Nothing here decides legality: an answer the engine or the production validator refuses
 * is recorded as invalid and the table plays that decision instead.
 */
import { HeuristicDecisionProvider } from '../../packages/bot/src';
import {
  buildCardScenario,
  describeScenarioRequest,
  formatSpectatorLog,
  type Engine,
} from '../../packages/engine/src';
import { validateResponse } from '../../packages/server/src/ai/validate';
import {
  NO_ATTACK_TARGET,
  NO_BLOCK_TARGET,
  type DecisionRequest,
  type DecisionResponse,
  type GameId,
  type GameState,
  type PlayerView,
} from '../../packages/shared/src';
import { buildAnswer, describeAnswer, namesOf } from './answers';
import { benchCard } from './cards';
import {
  DEFAULT_MAX_ACTOR_DECISIONS,
  caseScenario,
  type AnswerSpec,
  type BenchCase,
  type Seat,
} from './case';

/**
 * How an answer was produced, in the production pipeline's own vocabulary where it has one.
 */
export type AnswerSource =
  | 'model'
  | 'model-retry'
  | 'fallback'
  | 'heuristic'
  | 'cache'
  | 'plan'
  | 'local'
  | 'script'
  /** The card-aware bot in bot-led mode (ADR 0043), answering without the model. */
  | 'bot'
  | 'jev'
  /**
   * A decision model's seat handed a decision it cannot express (an attack, a block) to the
   * production fallback bot (ADR 0046). Not the model's answer.
   */
  | 'bot-handoff';

export type CostSource = 'reported' | 'estimated' | 'unknown' | 'not_applicable';

export interface ActorAnswer {
  response: DecisionResponse;
  source: AnswerSource;
  /** Wall-clock time the seat took to answer, retries included. */
  latencyMs: number;
  promptTokens?: number;
  responseTokens?: number;
  costUsd?: number;
  costSource: CostSource;
  /** Provider requests made for this decision. */
  requests: number;
  /** Why the model's own answer was not used, when it was not. */
  failure?: string;
  /** The model's raw text for this decision, when there was one. */
  raw?: string;
  /** Bot-led entries only: whether the bot handed this decision to the model. */
  escalated?: boolean;
  /** Bot-led entries only: the escalation triggers that fired, live or not. */
  reasons?: string[];
}

/** One seat's player for one game. */
export interface Actor {
  decide(request: DecisionRequest, view: PlayerView): Promise<ActorAnswer> | ActorAnswer;
}
export type ActorFactory = (engine: Engine, benchCase: BenchCase) => Actor;

export interface DecisionRecord {
  index: number;
  requestId: string;
  turn: number;
  phase: string;
  step: string | null;
  decisionType: string;
  prompt: string;
  optionCount: number;
  /** The answer that was played, in words. */
  action: string;
  /** The same answer without object ids: equal across models that chose the same thing. */
  actionKey: string;
  response: DecisionResponse;
  source: AnswerSource;
  latencyMs: number;
  promptTokens?: number;
  responseTokens?: number;
  costUsd?: number;
  costSource: CostSource;
  requests: number;
  note?: string;
  raw?: string;
  /** Set when the seat's own answer was refused; `action` is then what the table played instead. */
  invalid?: string;
  failure?: string;
  escalated?: boolean;
  reasons?: string[];
}

/** How often a bot-led entry handed the case's decisions to the model, and why (ADR 0043). */
export interface EscalationSummary {
  /** Decisions the bot was consulted on. */
  consulted: number;
  /** Of those, how many went to the model. */
  escalated: number;
  /** Times each trigger fired, whether or not it escalated. */
  byReason: Record<string, number>;
}

export interface SeatSnapshot {
  seat: Seat;
  alive: boolean;
  life: number;
  poison: number;
  library: number;
  hand: string[];
  battlefield: string[];
  graveyard: string[];
  exile: string[];
  creaturePower: number;
}
export type Snapshot = SeatSnapshot[];

export type Termination = 'complete' | 'decision_cap' | 'halted' | 'error';

export interface CaseRun {
  caseId: string;
  scope: BenchCase['scope'];
  /** The decision under test and what the seat could see when it was asked. */
  focus: { request: DecisionRequest; view: PlayerView; names: Record<string, string> };
  /** The seat's decisions under test, in order. One entry for a one-decision case. */
  decisions: DecisionRecord[];
  /** The public log from the focus to the end of the run. */
  log: string[];
  before: Snapshot;
  after: Snapshot;
  termination: Termination;
  error?: string;
  /** Bot-led entries only. */
  escalations?: EscalationSummary;
}

const HARD_DECISION_LIMIT = 600;

export function snapshot(state: GameState): Snapshot {
  return state.players.map((player) => {
    const permanents = state.battlefield.filter((item) => item.controllerId === player.id);
    return {
      seat: player.id as Seat,
      alive: !player.hasLost,
      life: player.life,
      poison: player.poisonCounters,
      library: player.library.length,
      hand: player.hand.map((card) => card.name).sort(),
      battlefield: permanents.map((item) => item.name).sort(),
      graveyard: player.graveyard.map((card) => card.name).sort(),
      exile: state.exile
        .filter((card) => card.ownerId === player.id)
        .map((card) => card.name)
        .sort(),
      creaturePower: permanents
        .filter((item) => item.typeLine.includes('Creature'))
        .reduce((sum, item) => sum + Math.max(0, item.power ?? 0), 0),
    };
  });
}

/** How the seats the benchmark is not testing answer: the case's script first, then its policy. */
class Table {
  private readonly bots = new Map<string, HeuristicDecisionProvider>();
  private next = 0;

  constructor(
    private readonly engine: Engine,
    private readonly benchCase: BenchCase,
  ) {}

  /** `still` answers with the passive policy whatever the case's own policy is. */
  answer(request: DecisionRequest, still = false): DecisionResponse {
    const script = this.benchCase.table?.script ?? [];
    const step = script[this.next];
    if (step !== undefined && step.player === request.decidingPlayer) {
      // A scripted reply names what it expects to see ("block the Dreadmaw"). When the seat under
      // test played so that it no longer applies, the step is spent and the policy answers.
      let scripted: DecisionResponse | null;
      try {
        scripted = buildAnswer(step, request, this.engine.getState(), true);
      } catch {
        scripted = null;
        this.next += 1;
      }
      if (scripted !== null) {
        this.next += 1;
        return scripted;
      }
    }
    return still || (this.benchCase.table?.policy ?? 'heuristic') === 'passive'
      ? passive(request)
      : this.bot(request.decidingPlayer).decide(request);
  }

  private bot(seat: string): HeuristicDecisionProvider {
    let bot = this.bots.get(seat);
    if (bot === undefined) {
      // The table stays the plain, pre-ADR 0043 bot so recorded reference lines keep holding.
      bot = new HeuristicDecisionProvider(
        `bot-bench:${this.benchCase.id}:${seat}`,
        () => this.engine.view(seat),
        { fixes: [] },
      );
      this.bots.set(seat, bot);
    }
    return bot;
  }
}

/** Holds still: passes priority, declares no attack and no block, else takes the first option. */
function passive(request: DecisionRequest): DecisionResponse {
  const action =
    request.legalActions.find((candidate) => candidate.type === 'pass') ?? request.legalActions[0];
  if (action === undefined) throw new Error('decision request with no legal actions');
  const targets = (action.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice:
      slot.options.find((option) => option === NO_ATTACK_TARGET || option === NO_BLOCK_TARGET) ??
      (slot.options[0] as string),
  }));
  return {
    requestId: request.requestId,
    actionId: action.id,
    ...(targets.length > 0 && { targets }),
  };
}

function isFocus(benchCase: BenchCase, request: DecisionRequest): boolean {
  if (request.decidingPlayer !== benchCase.actor) return false;
  const focus = benchCase.focus;
  if (focus?.decisionType !== undefined && request.decisionType !== focus.decisionType)
    return false;
  if (focus?.prompt !== undefined && !request.prompt.includes(focus.prompt)) return false;
  return true;
}

function passAction(request: DecisionRequest): DecisionResponse | null {
  if (request.decisionType !== 'priority') return null;
  const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
  return pass === undefined ? null : { requestId: request.requestId, actionId: pass.id };
}

export interface OpenedCase {
  engine: Engine;
  /** The decision under test, already surfaced and waiting for an answer. */
  request: DecisionRequest;
  view: PlayerView;
  /** Every object's name by id at the decision under test. */
  names: Record<string, string>;
}

/**
 * Arrange a case's position and play its `setup` to the decision under test. Before that
 * decision, a priority window the script does not act in is passed; any other unscripted
 * decision is an authoring error, so a position never depends on an unreviewed choice.
 */
export function openCase(benchCase: BenchCase): OpenedCase {
  const { file, scenario } = caseScenario(benchCase);
  const { engine } = buildCardScenario(file, scenario, benchCard, {
    gameId: `bot-bench-${benchCase.id}` as GameId,
  });
  const setup = benchCase.setup ?? [];
  let next = 0;
  for (let count = 0; count < HARD_DECISION_LIMIT; count++) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver')
      throw new Error(
        `${benchCase.id}: the position ended before the decision under test` +
          (step.result.halted ? ` (halted: ${step.result.haltReason ?? ''})` : ''),
      );
    const request = step.request;
    const scripted: (AnswerSpec & { player: Seat }) | undefined = setup[next];
    if (scripted !== undefined && scripted.player === request.decidingPlayer) {
      const response = buildAnswer(scripted, request, engine.getState());
      if (response !== null) {
        engine.submit(response);
        next += 1;
        continue;
      }
    }
    if (next >= setup.length && isFocus(benchCase, request))
      return {
        engine,
        request,
        view: engine.view(benchCase.actor),
        names: Object.fromEntries(namesOf(engine.getState())),
      };
    const pass = passAction(request);
    if (pass === null)
      throw new Error(
        `${benchCase.id}: setup does not answer a decision before the one under test` +
          (scripted === undefined ? '' : ` (next step: ${scripted.player} "${scripted.choose}")`) +
          `:\n${describeScenarioRequest(request)}`,
      );
    engine.submit(pass);
  }
  throw new Error(`${benchCase.id}: no decision under test after ${HARD_DECISION_LIMIT} decisions`);
}

/** Play a case with one actor in the seat under test. Deterministic for a deterministic actor. */
export async function playCase(benchCase: BenchCase, makeActor: ActorFactory): Promise<CaseRun> {
  const { engine, request: focusRequest, view: focusView, names: focusNames } = openCase(benchCase);
  const table = new Table(engine, benchCase);
  const actor = makeActor(engine, benchCase);
  const before = snapshot(engine.getState());
  const firstSequence = engine.getState().eventLog.length;
  const cap =
    benchCase.scope === 'single' ? 1 : (benchCase.maxActorDecisions ?? DEFAULT_MAX_ACTOR_DECISIONS);
  const decisions: DecisionRecord[] = [];
  let termination: Termination = 'complete';
  let error: string | undefined;

  // After the one decision a `single` case tests, the tested seat holds still (unless the case
  // scripts it or hands it to the bot), so the run shows that decision's consequence and no more.
  const playTable = (request: DecisionRequest, forceStill = false): DecisionResponse => {
    const still =
      forceStill ||
      (benchCase.scope === 'single' &&
        request.decidingPlayer === benchCase.actor &&
        (benchCase.table?.actorAfterFocus ?? 'still') === 'still');
    const response = table.answer(request, still);
    engine.submit(response);
    return response;
  };

  try {
    let request: DecisionRequest | null = focusRequest;
    for (let count = 0; request !== null; count++) {
      if (count >= HARD_DECISION_LIMIT) throw new Error('no end to the run');
      if (request.decidingPlayer !== benchCase.actor) {
        playTable(request);
      } else if (decisions.length >= cap) {
        if (benchCase.scope === 'turn') termination = 'decision_cap';
        // Past a whole turn's cap the tested seat holds still: letting the table's bot play it
        // would credit the bot's moves (an Overrun, a lethal attack) to the model's score. A
        // one-decision case is always past its cap after the focus, and keeps the case's own
        // post-focus policy (`table.actorAfterFocus`), so its consequences play out as reviewed.
        playTable(request, benchCase.scope === 'turn');
      } else {
        const names = namesOf(engine.getState());
        const answer = await actor.decide(request, engine.view(benchCase.actor));
        let played = answer.response;
        let invalid: string | undefined;
        if (answer.source === 'fallback') {
          // The model did not make this decision; the pipeline's fallback bot did. The benchmark
          // holds the seat still instead, so nothing the fallback would have achieved (an
          // Overrun, a lethal attack) is credited to the model.
          played = playTable(request, true);
        } else {
          invalid = validateResponse(answer.response, request) ?? undefined;
          if (invalid === undefined) {
            try {
              engine.submit(answer.response);
            } catch (cause) {
              invalid = cause instanceof Error ? cause.message : String(cause);
            }
          }
          // Likewise for an answer the engine refused: the seat holds still.
          if (invalid !== undefined) played = playTable(request, true);
        }
        const described = describeAnswer(request, played, names);
        const record: DecisionRecord = {
          index: decisions.length,
          requestId: request.requestId,
          turn: request.turn,
          phase: request.phase,
          step: request.step,
          decisionType: request.decisionType,
          prompt: request.prompt,
          optionCount: request.legalActions.length,
          action: described.text,
          actionKey: described.key,
          response: played,
          source: answer.source,
          latencyMs: answer.latencyMs,
          costSource: answer.costSource,
          requests: answer.requests,
          ...(answer.promptTokens !== undefined && { promptTokens: answer.promptTokens }),
          ...(answer.responseTokens !== undefined && { responseTokens: answer.responseTokens }),
          ...(answer.costUsd !== undefined && { costUsd: answer.costUsd }),
          ...(answer.response.note !== undefined && { note: answer.response.note }),
          ...(answer.raw !== undefined && { raw: answer.raw }),
          ...(invalid !== undefined && { invalid }),
          ...(answer.failure !== undefined && { failure: answer.failure }),
          ...(answer.escalated !== undefined && { escalated: answer.escalated }),
          ...(answer.reasons !== undefined && { reasons: answer.reasons }),
        };
        decisions.push(record);
      }
      request = null;
      for (;;) {
        const step = engine.advance();
        if (step.kind === 'continue') continue;
        if (step.kind === 'gameOver') {
          if (step.result.halted) {
            termination = 'halted';
            error = step.result.haltReason ?? 'the engine halted';
          }
          break;
        }
        request = step.request;
        break;
      }
    }
  } catch (cause) {
    termination = 'error';
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  }

  const state = engine.getState();
  const escalations = summarizeEscalations(decisions);
  return {
    caseId: benchCase.id,
    scope: benchCase.scope,
    focus: { request: focusRequest, view: focusView, names: focusNames },
    decisions,
    // The arranged window always ends in the scenario's own "game over" line; it is not an event.
    log: formatSpectatorLog(
      state.eventLog.slice(firstSequence).filter((event) => event.type !== 'gameOver'),
    ).map((line) => (line.actorSeat === null ? line.text : `${line.actorSeat}: ${line.text}`)),
    before,
    after: snapshot(state),
    termination,
    ...(error !== undefined && { error }),
    ...(escalations !== undefined && { escalations }),
  };
}

/** Escalation counts over a run's decisions, or undefined when no decision came from a bot-led seat. */
export function summarizeEscalations(
  decisions: readonly DecisionRecord[],
): EscalationSummary | undefined {
  const consulted = decisions.filter((decision) => decision.escalated !== undefined);
  if (consulted.length === 0) return undefined;
  const byReason: Record<string, number> = {};
  for (const decision of consulted)
    for (const reason of decision.reasons ?? []) byReason[reason] = (byReason[reason] ?? 0) + 1;
  return {
    consulted: consulted.length,
    escalated: consulted.filter((decision) => decision.escalated === true).length,
    byReason,
  };
}

/** An actor that answers every decision with a fixed function; free and instant. */
export function localActor(
  source: AnswerSource,
  decide: (request: DecisionRequest, view: PlayerView) => DecisionResponse,
): Actor {
  return {
    decide(request, view) {
      const started = performance.now();
      const response = decide(request, view);
      return {
        response,
        source,
        latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
        costUsd: 0,
        costSource: 'not_applicable',
        requests: 0,
      };
    },
  };
}

/** Always answers the decision under test with one fixed answer (reference analysis). */
export function fixedAnswerActor(response: DecisionResponse): ActorFactory {
  return () => localActor('script', () => response);
}

/**
 * Plays a reviewed line: each of the seat's decisions takes the next step that names it. A
 * priority window no step names is passed; with every step used, the seat yields the turn.
 * `unused` reports the steps the run never reached, so a stale line is caught.
 */
export function scriptedActor(steps: readonly AnswerSpec[]): {
  factory: ActorFactory;
  unused: () => AnswerSpec[];
} {
  let next = 0;
  const factory: ActorFactory = (engine) =>
    localActor('script', (request) => {
      const step = steps[next];
      if (step !== undefined) {
        const response = buildAnswer(step, request, engine.getState());
        if (response !== null) {
          next += 1;
          return response;
        }
      }
      const pass = passAction(request);
      if (pass !== null) {
        const yieldTurn = request.legalActions.find((a) => a.type === 'passAndYieldTurn');
        return next >= steps.length && yieldTurn !== undefined
          ? { requestId: request.requestId, actionId: yieldTurn.id }
          : pass;
      }
      return passive(request);
    });
  return { factory, unused: () => steps.slice(next) };
}
