/**
 * A stand-in for an OpenAI-compatible endpoint, for tests: it hands the request's own position
 * and legal menu to a scripted "model" and wraps what that returns as a chat completion. No
 * network is involved; everything else in the pipeline is the production code.
 */
import type { LegalAction } from '../../packages/shared/src';

export interface FakeTurn {
  /** The model id the request asked for. */
  model: string;
  requestId: string;
  prompt: string;
  legalActions: LegalAction[];
  /** How many times this request has been sent, starting at 1. */
  attempt: number;
  /** Object names by id, from the battlefield, hand and stack in the prompt. */
  names: Map<string, string>;
  messages: Array<{ role: string; content: string }>;
}

export type FakeReply =
  | string
  | { status: number; body: string }
  | { content: string; promptTokens?: number; completionTokens?: number; cost?: number };

export function fakeProvider(
  model: (turn: FakeTurn) => FakeReply,
  calls: FakeTurn[] = [],
): typeof fetch {
  const attempts = new Map<string, number>();
  const handler = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    const payload = JSON.parse(body.messages[1]!.content) as {
      ctx: { reqId: string; prompt: string };
      you: { hand: Array<{ id: string; name: string }> };
      battlefield: Array<{ id: string; name: string }>;
      stack: Array<{ id: string; description: string }>;
      legalActions: LegalAction[];
    };
    const attempt = (attempts.get(payload.ctx.reqId) ?? 0) + 1;
    attempts.set(payload.ctx.reqId, attempt);
    const names = new Map<string, string>();
    for (const item of [...payload.battlefield, ...payload.you.hand]) names.set(item.id, item.name);
    for (const item of payload.stack) names.set(item.id, item.description);
    const turn: FakeTurn = {
      model: body.model,
      requestId: payload.ctx.reqId,
      prompt: payload.ctx.prompt,
      legalActions: payload.legalActions,
      attempt,
      names,
      messages: body.messages,
    };
    calls.push(turn);
    const reply = model(turn);
    if (typeof reply === 'object' && 'status' in reply)
      return new Response(reply.body, { status: reply.status });
    const content = typeof reply === 'string' ? reply : reply.content;
    const usage: { promptTokens?: number; completionTokens?: number; cost?: number } =
      typeof reply === 'string' ? {} : reply;
    return new Response(
      JSON.stringify({
        id: `fake-${payload.ctx.reqId}-${attempt}`,
        model: 'fake/secret-model-name',
        provider: 'FakeBackend',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: {
          prompt_tokens: usage.promptTokens ?? 1200,
          completion_tokens: usage.completionTokens ?? 30,
          ...(usage.cost !== undefined && { cost: usage.cost }),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return handler as unknown as typeof fetch;
}

/** Reply JSON choosing the action whose description contains `choose`, with targets by name. */
export function pick(
  turn: FakeTurn,
  choose: string,
  targets: string[] = [],
  note?: string,
): string {
  const action = turn.legalActions.find((candidate) => candidate.description.includes(choose));
  if (action === undefined) throw new Error(`fake model: no action "${choose}"`);
  return JSON.stringify({
    requestId: turn.requestId,
    actionId: action.id,
    ...(targets.length > 0 && {
      targets: (action.targets ?? []).map((slot, index) => ({
        slot: slot.slot,
        choice:
          slot.options.find(
            (option) => option === targets[index] || turn.names.get(option) === targets[index],
          ) ?? targets[index],
      })),
    }),
    ...(note !== undefined && { note }),
  });
}
