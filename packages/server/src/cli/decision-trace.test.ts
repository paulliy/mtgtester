import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { DecisionTraceWriter, decisionTraceLine, nameOf } from './decision-trace';

const view = {
  seat: 'P1',
  life: 30,
  hand: [{ id: 'h1', name: 'Shock', typeLine: 'Instant' }],
  battlefield: [
    {
      id: 'b1',
      controller: 'P3',
      name: 'Savannah Lions',
      typeLine: 'Creature',
      tapped: false,
      status: [],
    },
  ],
  stack: [{ id: 's1', controller: 'P2', description: 'Mind Stone', targets: [] }],
  graveyard: [],
  opponents: [{ seat: 'P2', graveyard: [] }],
} as unknown as PlayerView;

const request: DecisionRequest = {
  requestId: 'r1',
  gameId: 'g',
  turn: 6,
  activePlayer: 'P2',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'not traced',
  legalActions: [
    { id: 0, type: 'pass', description: 'Pass priority' },
    {
      id: 1,
      type: 'castSpell',
      description: 'Cast Shock',
      targets: [{ slot: 0, options: ['P2', 'b1'] }],
    },
  ],
};

describe('decision trace', () => {
  it('names players, permanents, hand cards and stack objects, and falls back to the id', () => {
    expect(['P1', 'P2', 'b1', 'h1', 's1', 'zz'].map((id) => nameOf(id, view))).toEqual([
      'P1',
      'P2',
      'Savannah Lions',
      'Shock',
      'Mind Stone',
      'zz',
    ]);
  });

  it('records the menu, the answer by name, who answered and what fired, and no prompt', () => {
    const line = decisionTraceLine({
      request,
      response: { requestId: 'r1', actionId: 1, targets: [{ slot: 0, choice: 'b1' }] },
      view,
      mode: 'bot',
      source: 'bot',
      bot: { escalated: false, reasons: ['scarce-answer'] },
      steering: { aggression: 0.7 },
      life: { P1: 30, P2: 28 },
    });
    expect(line).toEqual({
      kind: 'decision',
      turn: 6,
      activePlayer: 'P2',
      phase: 'precombatMain',
      step: null,
      seat: 'P1',
      mode: 'bot',
      decisionType: 'priority',
      menu: [
        { id: 0, type: 'pass', description: 'Pass priority' },
        { id: 1, type: 'castSpell', description: 'Cast Shock' },
      ],
      chosen: { id: 1, description: 'Cast Shock', targets: ['Savannah Lions'] },
      source: 'bot',
      escalated: false,
      reasons: ['scarce-answer'],
      steering: { aggression: 0.7 },
      life: { P1: 30, P2: 28 },
    });
    expect(JSON.stringify(line)).not.toContain('not traced');
  });

  it('writes one JSON object per line, starting from an empty file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'trace-')), 't.jsonl');
    const first = new DecisionTraceWriter(path);
    first.write({ kind: 'old' });
    const writer = new DecisionTraceWriter(path);
    writer.write({ kind: 'decision', n: 1 });
    writer.write({ kind: 'end' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as { kind: string }).map((l) => l.kind)).toEqual([
      'decision',
      'end',
    ]);
  });
});
