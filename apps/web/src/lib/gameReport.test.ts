import { describe, expect, it } from 'vitest';
import type { GameReport } from '@mtg/shared';
import { formatGameReport } from './gameReport';

function report(over: Partial<GameReport> = {}): GameReport {
  return {
    schemaVersion: 2,
    generatedAt: '2026-10-05T02:00:00.000Z',
    build: { commit: 'ca22469', branch: 'claude/feature', dirty: false },
    cardData: { source: 'data/scryfall-oracle-cards.json', sha256: 'f00d', entries: 38705 },
    game: {
      id: 'g1-seed',
      seed: 'cloud-full-game-2026-10-05',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      providerKind: 'random',
      playbackMode: 'live',
      paceMs: 0,
      startedAt: '2026-10-05T01:48:05.127Z',
      cardTestScenarioId: null,
    },
    status: { runner: 'awaitingHuman', over: false, winnerSeat: null, halt: null },
    position: {
      turn: 50,
      phase: 'precombatMain',
      step: null,
      activePlayer: 'P1',
      priorityPlayer: 'P1',
    },
    seats: [
      {
        seat: 'P1',
        controller: 'human',
        label: 'Ghalta and Mavren',
        commanderNames: ['Ghalta and Mavren'],
        colorIdentity: ['G', 'W'],
        archetypeTag: 'tokens',
        deckSnapshotId: 'snap-1',
        source: { kind: 'pool', seed: 'cloud-full-game-2026-10-05-seat1' },
        decklist: {
          commanders: ['Ghalta and Mavren'],
          companion: 'Jegantha, the Wellspring',
          library: ['2 Forest'],
        },
        life: 36,
        poisonCounters: 0,
        handSize: 3,
        librarySize: 40,
        hasLost: false,
        lossReason: null,
      },
      {
        seat: 'P3',
        controller: 'random',
        label: 'Iron Lad',
        commanderNames: ['Iron Lad, Young Avenger'],
        colorIdentity: ['U', 'R'],
        archetypeTag: 'artifacts',
        deckSnapshotId: null,
        source: { kind: 'url', url: null },
        decklist: null,
        life: 0,
        poisonCounters: 2,
        handSize: 0,
        librarySize: 0,
        hasLost: true,
        lossReason: 'lifeZeroOrLess',
      },
    ],
    pendingChoice: {
      requestId: 'r-9',
      decisionType: 'general',
      prompt: 'Adaptive Sporesinger: choose a mode',
      options: ['Target creature gets +2/+2', 'Proliferate'],
    },
    lastSubmittedAction: {
      requestId: 'r-8',
      turn: 50,
      decisionType: 'priority',
      description: 'Cast Adaptive Sporesinger',
      targets: [],
    },
    recentLog: ['T50 P1 Cast Adaptive Sporesinger'],
    ...over,
  };
}

describe('formatGameReport', () => {
  it('leads with what a bug report needs: build, game id, seed, status and position', () => {
    const text = formatGameReport(report());
    expect(text).toContain('Build: claude/feature @ ca22469');
    expect(text).toContain(
      'Card data: data/scryfall-oracle-cards.json (38,705 entries, sha256 f00d)',
    );
    expect(text).toContain('g1-seed · seed `cloud-full-game-2026-10-05`');
    expect(text).toContain('Status: awaitingHuman');
    expect(text).toContain('Position: Turn 50 · Main phase 1 · active P1 · priority P1');
    expect(text).toContain('- Proliferate');
    expect(text).toContain('Turn 50: Cast Adaptive Sporesinger (priority)');
    expect(text).toContain('T50 P1 Cast Adaptive Sporesinger');
  });

  it('prints only the decklists the server released, and says why an opponent source is hidden', () => {
    const text = formatGameReport(report());
    expect(text).toContain('### P1 decklist (engine order)');
    expect(text).toContain(
      'Commander: 1 Ghalta and Mavren\nCompanion: 1 Jegantha, the Wellspring\n2 Forest',
    );
    expect(text).not.toContain('### P3 decklist');
    expect(text).toContain('imported URL (hidden until game over)');
    expect(text).toContain('lost (lifeZeroOrLess)');
  });

  it('ends with the complete JSON so no field is lost to formatting', () => {
    const value = report();
    const text = formatGameReport(value);
    const json = text.slice(text.indexOf('```json') + 7, text.lastIndexOf('```'));
    expect(JSON.parse(json)).toEqual(value);
  });

  it('reports halts and an unknown build plainly', () => {
    const text = formatGameReport(
      report({
        build: { commit: null, branch: null, dirty: null },
        status: {
          runner: 'halted',
          over: true,
          winnerSeat: null,
          halt: { kind: 'engineError', turn: 12 },
        },
      }),
    );
    expect(text).toContain('Build: unknown');
    expect(text).toContain('Status: halted (engineError) on turn 12');
  });
});
