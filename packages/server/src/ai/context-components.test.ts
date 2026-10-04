import { describe, expect, it } from 'vitest';
import type { DecisionRequest, GameEvent, PlayerView } from '@mtg/shared';
import { summarizeHandCard } from './card-summary';
import { budgetContext } from './context-budget';
import { PublicMemoryTracker } from './public-memory';
import { extractStateFeatures } from './state-features';

const request: DecisionRequest = {
  requestId: 'r1',
  gameId: 'g1',
  turn: 4,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'Choose',
  legalActions: [
    { id: 0, type: 'pass', description: 'Pass' },
    { id: 1, type: 'castSpell', description: 'Cast Conditional Study' },
  ],
};

const view: PlayerView = {
  seat: 'P1',
  life: 30,
  hand: [],
  deck: [],
  graveyard: [],
  commanders: [],
  availableMana: { W: 1, U: 1 },
  manaSources: [{ name: 'Flexible Land', symbols: ['W', 'U'], count: 1 }],
  opponents: [],
  battlefield: [],
  exile: [],
  stack: [],
  recentLog: [],
};

function event(sequence: number, type: string, payload: Record<string, unknown>): GameEvent {
  return {
    sequence,
    turn: 4,
    phase: 'precombatMain',
    step: null,
    actorSeat: 'P2',
    type,
    payload,
  };
}

describe('Milestone 4 context components', () => {
  it('builds bounded structured public memory without retaining private draws or library moves', () => {
    const tracker = new PublicMemoryTracker(3);
    tracker.observe([
      event(1, 'draw', { player: 'P2', name: 'Secret Counterspell' }),
      event(2, 'zoneChange', { name: 'Hidden Tutor Target', from: 'library', to: 'hand' }),
      event(3, 'searchFound', { player: 'P2', name: 'Hidden Tutor Answer', to: 'hand' }),
      event(4, 'counterSpell', { countered: 'Threat', by: 'Public Counter' }),
    ]);
    const snapshot = tracker.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('Secret Counterspell');
    expect(JSON.stringify(snapshot)).not.toContain('Hidden Tutor Target');
    expect(JSON.stringify(snapshot)).not.toContain('Hidden Tutor Answer');
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      kind: 'tutor',
      detail: 'P2 searched for a hidden card to hand',
      knowledge: 'public_now',
    });
    expect(snapshot.entries[0]?.sourceEventSequence).toBe(3);
  });

  it('retains a tutored identity only when the event made it public', () => {
    const tracker = new PublicMemoryTracker();
    tracker.observe([
      event(1, 'searchFound', {
        player: 'P2',
        name: 'Revealed Answer',
        to: 'hand',
        revealed: true,
      }),
      event(2, 'searchFound', { player: 'P2', name: 'Public Permanent', to: 'battlefield' }),
    ]);
    expect(tracker.snapshot().entries).toMatchObject([
      { card: 'Revealed Answer', knowledge: 'historical_public' },
      { card: 'Public Permanent', knowledge: 'public_now' },
    ]);
  });

  it('keeps flexible mana alternatives grouped instead of double-counting one source', () => {
    const features = extractStateFeatures(request, view);
    expect(features.exact.manaSources).toEqual([
      { name: 'Flexible Land', sourceCount: 1, alternatives: ['W', 'U'] },
    ]);
    expect(features.exact.castableActionIds).toEqual([1]);
    expect(features.lethal.status).toBe('unknown');
  });

  it('aggregates repeated public destruction by one source into a wipe memory', () => {
    const tracker = new PublicMemoryTracker();
    tracker.observe([
      event(1, 'destroy', { source: 'Public Sweeper', target: 'One' }),
      event(2, 'destroy', { source: 'Public Sweeper', target: 'Two' }),
      event(3, 'destroy', { source: 'Public Sweeper', target: 'Three' }),
    ]);
    const wipe = tracker.snapshot().entries.find((entry) => entry.kind === 'wipe');
    expect(wipe?.card).toBe('Public Sweeper');
    expect(wipe?.sourceEventSequence).toBe(3);
    expect(wipe?.detail).toContain('at least 3 permanents');
  });

  it('never removes mandatory decision surfaces and emits an explicit larger-context route', () => {
    const legalActions = Array.from({ length: 20 }, (_, id) => ({
      id,
      type: 'castSpell',
      description: `Cast mandatory option ${id}`,
    }));
    const payload = {
      legalActions,
      stack: [{ id: 'stack-1', description: 'Mandatory stack effect' }],
      you: { hand: [{ id: 'h1', name: 'Mandatory card', text: 'A'.repeat(2_000) }] },
      battlefield: [{ id: 'p1', name: 'Mandatory permanent', text: 'B'.repeat(2_000) }],
      recentLog: Array.from({ length: 30 }, (_, index) => `optional ${index}`),
    };
    const result = budgetContext(payload, 100);
    expect(result.payload.legalActions).toHaveLength(20);
    expect(result.payload.stack).toHaveLength(1);
    expect(result.payload.you.hand).toHaveLength(1);
    expect(result.report.exceeded).toBe(true);
    expect(result.report.route).toBe('larger_context_required');
    expect(result.report.omissions.some((item) => item.section === 'recentLog')).toBe(true);
  });

  it('preserves conditions, targets, payments, and choices in strategic card summaries', () => {
    const summary = summarizeHandCard(
      {
        id: 'h1',
        name: 'Conditional Study',
        oracleText:
          'When this enters, choose target opponent. Unless that player pays {2}, draw two cards.',
      },
      { ...request, legalActions: [{ id: 0, type: 'pass', description: 'Pass' }] },
      true,
    );
    expect(summary.text).toContain('When this enters');
    expect(summary.text).toContain('target opponent');
    expect(summary.text).toContain('pays {2}');
    expect(summary.text).toContain('draw two cards');
  });

  it('never drops restrictions or keywords from a summarized Oracle text box', () => {
    const summary = summarizeHandCard(
      {
        id: 'safety-card',
        name: 'Safety Card',
        oracleText:
          "Flying\nPlayers can't gain life.\nThis creature's power is equal to your devotion to white.",
      },
      { ...request, legalActions: [{ id: 0, type: 'pass', description: 'Pass' }] },
      true,
    );
    expect(summary.text).toBe(
      "Flying Players can't gain life. This creature's power is equal to your devotion to white.",
    );
  });
});
