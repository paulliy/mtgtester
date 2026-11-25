import { describe, expect, it } from 'vitest';
import {
  buildLabel,
  callLines,
  gameOptionLabel,
  haltLine,
  hasNoResponse,
  humanize,
  isReadable,
  latencyLabel,
  logLines,
  messageSeat,
  prettyJson,
  roundLabel,
  roundOf,
  roundsWithData,
  tokenShare,
  type AiCallRow,
  type DebugEventRow,
} from './debugModel';

const event = (
  sequence: number,
  turn: number,
  category: string,
  message: string,
): DebugEventRow => ({
  sequence,
  turn,
  category,
  message,
  data_json: null,
});
const call = (patch: Partial<AiCallRow>): AiCallRow => ({
  sequence: 1,
  seat: 2,
  model: 'm',
  prompt_tokens: 100,
  response_tokens: 20,
  was_retry: 0,
  was_fallback: 0,
  latency_ms: 1800,
  cost_usd: null,
  source: 'primary',
  turn: 5,
  request_json: JSON.stringify({ decisionType: 'declareBlockers', turn: 5 }),
  response_json: '{"actionId":1}',
  ...patch,
});

describe('rounds', () => {
  it('groups a four-seat game by round with turn 0 as setup', () => {
    expect([0, 1, 4, 5, 8, 9].map((turn) => roundOf(turn, 4))).toEqual([0, 1, 1, 2, 2, 3]);
    expect(roundLabel(0)).toBe('Setup');
    expect(roundLabel(3)).toBe('R3');
  });
});

describe('engine log', () => {
  it('keeps readable categories and turn headings, names the seat, and ends on the halt', () => {
    const data = {
      game: null,
      aiCalls: [],
      debugEvents: [
        event(1, 0, 'engine', 'starting player: P4'),
        event(2, 1, 'turn', '--- turn 1: P4 ---'),
        event(3, 1, 'turn', 'step: upkeep'),
        event(4, 1, 'priority', 'P4 passes'),
        event(5, 1, 'stack', 'P2 casts Sol Ring'),
        event(6, 1, 'sba', 'SBA check'),
      ],
      events: [
        {
          sequence: 9,
          turn: 5,
          event_type: 'gameOver',
          payload_json: '{"halted":true,"haltReason":"budget exhausted"}',
        },
      ],
    };
    const lines = logLines(data, 4);
    expect(lines.map((line) => line.text)).toEqual([
      'starting player: P4',
      '--- turn 1: P4 ---',
      'P2 casts Sol Ring',
      'Halt: budget exhausted. Game stopped.',
    ]);
    expect(lines.map((line) => line.seat)).toEqual(['D', 'D', 'B', '—']);
    expect(lines.at(-1)).toMatchObject({ halt: true, round: 2 });
    expect(isReadable(event(1, 1, 'decision', 'x'))).toBe(false);
  });

  it('has no halt line for a game that ended normally or has no game over event', () => {
    expect(haltLine([], 4)).toBeNull();
    expect(
      haltLine(
        [{ sequence: 1, turn: 3, event_type: 'gameOver', payload_json: '{"halted":false}' }],
        4,
      ),
    ).toBeNull();
  });

  it('finds no seat in a message that names none', () => {
    expect(messageSeat('Forest: library → hand')).toBe('—');
    expect(messageSeat('Jaspera Sentinel attacks P1')).toBe('A');
  });
});

describe('AI calls', () => {
  it('labels the decision, totals tokens and flags a call with no response', () => {
    const [ok, failed] = callLines(
      [call({}), call({ sequence: 2, was_fallback: 1, response_json: null, latency_ms: 0 })],
      4,
    );
    expect(ok).toMatchObject({ decision: 'Declare blockers', seat: 'B', tokens: 120, round: 2 });
    expect(ok?.noResponse).toBe(false);
    expect(failed?.noResponse).toBe(true);
    expect(hasNoResponse(call({ response_json: '' }))).toBe(true);
  });

  it('falls back to the source when the request is unreadable', () => {
    expect(callLines([call({ request_json: 'nope', source: 'strategist' })], 4)[0]?.decision).toBe(
      'Strategist',
    );
    expect(humanize('castSpell')).toBe('Cast spell');
  });

  it('formats latency and bar widths', () => {
    expect(latencyLabel(1800)).toBe('1.8 s');
    expect(latencyLabel(420)).toBe('420 ms');
    expect(latencyLabel(0)).toBe('—');
    expect(tokenShare(50, 200)).toBe(0.25);
    expect(tokenShare(5, 0)).toBe(0);
  });
});

describe('filters and labels', () => {
  it('lists only rounds that have data, sorted', () => {
    const lines = logLines(
      {
        game: null,
        events: [],
        aiCalls: [],
        debugEvents: [event(1, 9, 'engine', 'a'), event(2, 1, 'engine', 'b')],
      },
      4,
    );
    expect(roundsWithData(lines, callLines([call({ turn: 20 })], 4))).toEqual([1, 3, 5]);
  });

  it('pretty-prints JSON and leaves other text alone', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('not json')).toBe('not json');
    expect(prettyJson(null)).toBe('');
  });

  it('describes a game and the engine build', () => {
    const label = gameOptionLabel(
      {
        gameId: 'g',
        seed: 's1',
        status: 'finished',
        startedAt: null,
        endedAt: null,
        turnCount: 9,
        winnerSeat: 3,
        gameMode: 'spectator',
        batchId: null,
        scenarioName: null,
        buildCommit: null,
        seats: [],
      },
      true,
    );
    expect(label).toBe('live · undated · seed s1 · finished · winner C');
    expect(buildLabel('0123456789abcdef', 1)).toBe('engine 01234567 (dirty tree)');
    expect(buildLabel(null, null)).toBe('engine build not recorded');
  });
});
