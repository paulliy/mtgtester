/**
 * Per-decision traces for paid duels (`ai-mode-duel --trace`), so a game can be reviewed after the
 * fact: which seat decided what, from which menu, who answered it (the bot, the cache, a plan, the
 * model or the fallback), which escalation triggers fired, and the strategist knobs in force.
 *
 * One JSON object per line. A line is appended as each decision is answered, so a game that hangs
 * or is stopped by hand still leaves every decision it made. The last line of a finished game has
 * `kind: 'end'`.
 *
 * A trace holds what the deciding seat could see (its menu, the names on its view) and the answer
 * it gave. It never holds a prompt, hidden hand contents beyond the seat's own, or an API key.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  PlayerId,
  PlayerView,
} from '@mtg/shared';
import type { BotComparison } from '../ai/logger';

export interface DecisionTraceInput {
  request: DecisionRequest;
  response: DecisionResponse;
  /** The deciding seat's view when it decided, for naming the objects it chose. */
  view: PlayerView;
  mode: string;
  /** Who answered: the logger's source for the request, or `unknown` if nothing was logged. */
  source: string;
  /** Bot-led seats: whether the bot escalated to the model, and every trigger that fired. */
  bot?: { escalated: boolean; reasons: readonly string[]; escalatedBy?: string };
  steering?: BotSteering;
  /** The bot's choice beside a model-answered decision, when one was recorded. */
  comparison?: BotComparison;
  /** Life of every seat when the decision was made. */
  life: Record<string, number>;
}

export interface DecisionTraceLine {
  kind: 'decision';
  turn: number;
  activePlayer: PlayerId;
  phase: string;
  step: string | null;
  seat: PlayerId;
  mode: string;
  decisionType: string;
  /** The menu, in the engine's words, by action id. */
  menu: Array<{ id: number; type: string; description: string }>;
  chosen: { id: number; description: string; targets?: string[] };
  source: string;
  escalated?: boolean;
  reasons?: readonly string[];
  escalatedBy?: string;
  steering?: BotSteering;
  /** What the bot would have played on a model-answered decision. */
  botPick?: {
    kind: BotComparison['kind'];
    actionId: number | null;
    description?: string;
    sameAction: boolean;
    agreed?: boolean;
    top: BotComparison['botTop'];
    playedBotScore?: number;
  };
  life: Record<string, number>;
}

/** A name for an object id as the seat sees it, or the id itself when the view has no name. */
export function nameOf(id: string, view: PlayerView): string {
  if (id === view.seat || view.opponents.some((o) => o.seat === id)) return id;
  return (
    view.battlefield.find((p) => p.id === id)?.name ??
    view.hand.find((c) => c.id === id)?.name ??
    view.stack.find((s) => s.id === id)?.description ??
    view.graveyard.find((c) => c.id === id)?.name ??
    view.opponents.flatMap((o) => o.graveyard).find((c) => c.id === id)?.name ??
    id
  );
}

export function decisionTraceLine(input: DecisionTraceInput): DecisionTraceLine {
  const { request, response, view } = input;
  const chosenAction = request.legalActions.find((a) => a.id === response.actionId);
  const targets = (response.targets ?? []).map((t) => nameOf(String(t.choice), view));
  return {
    kind: 'decision',
    turn: request.turn,
    activePlayer: request.activePlayer,
    phase: request.phase,
    step: request.step,
    seat: request.decidingPlayer,
    mode: input.mode,
    decisionType: request.decisionType,
    menu: request.legalActions.map((a) => ({ id: a.id, type: a.type, description: a.description })),
    chosen: {
      id: response.actionId,
      description: chosenAction?.description ?? `unknown action ${response.actionId}`,
      ...(targets.length > 0 && { targets }),
    },
    source: input.source,
    ...(input.bot !== undefined && {
      escalated: input.bot.escalated,
      reasons: input.bot.reasons,
      ...(input.bot.escalatedBy !== undefined && { escalatedBy: input.bot.escalatedBy }),
    }),
    ...(input.steering !== undefined && { steering: input.steering }),
    ...(input.comparison !== undefined && { botPick: botPickOf(input.comparison, request) }),
    life: input.life,
  };
}

function botPickOf(
  c: BotComparison,
  request: DecisionRequest,
): NonNullable<DecisionTraceLine['botPick']> {
  const description = request.legalActions.find((a) => a.id === c.botActionId)?.description;
  return {
    kind: c.kind,
    actionId: c.botActionId,
    ...(description !== undefined && { description }),
    sameAction: c.sameAction,
    ...(c.agreed !== undefined && { agreed: c.agreed }),
    top: c.botTop,
    ...(c.playedBotScore !== undefined && { playedBotScore: c.playedBotScore }),
  };
}

/** Appends trace lines to a file, started empty. */
export class DecisionTraceWriter {
  constructor(private readonly path: string) {
    writeFileSync(path, '');
  }

  write(line: object): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }
}
