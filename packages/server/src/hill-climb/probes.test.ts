import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { PINNED_ORACLE_PATH, type PinnedCard } from '../cards/edhrec-pins';
import { loadDecks } from '../cli/fuzz-plan';
import {
  PROBES,
  PROFILES,
  backlogRefusals,
  calibrate,
  compilerProbe,
  compilerScreenMetrics,
  coverageProbe,
  edhrecCoverage,
  engineProbe,
  modelProbe,
  playableDeckPct,
  timed,
} from './probes';
import { compareReports, type Baseline, type Report } from './report';

const BASELINE_PATH = 'packages/server/fixtures/hill-climb-baseline.json';
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

describe('the committed hill-climb baseline', () => {
  it('holds a clean report for every profile, with every probe and its fingerprints', () => {
    expect(Object.keys(baseline.profiles).sort()).toEqual(Object.keys(PROFILES).sort());
    for (const [name, report] of Object.entries(baseline.profiles)) {
      expect(report.profile).toBe(name);
      expect(report.dirty, `${name} was measured on uncommitted changes`).toBe(false);
      expect(report.probes).toEqual([...PROBES]);
      expect(Object.keys(report.fingerprints)).toHaveLength(PROFILES[name]!.engineGames);
      for (const probe of PROBES)
        expect(
          Object.keys(report.metrics).some((id) => id.startsWith(`${probe}.`)),
          `${name} has no ${probe} metric`,
        ).toBe(true);
      for (const metric of Object.values(report.metrics))
        expect(Number.isFinite(metric.value)).toBe(true);
    }
  });
});

/**
 * The regression gate for the metrics that repeat exactly on any machine. A failure here means a
 * change made games cost more model calls or tokens, or lost card coverage. If that is intended,
 * rewrite the baseline with `bun run hill-climb --write-baseline` and say why in the pull request.
 * Timings and fingerprints are checked by `bun run hill-climb`, not here: timings are not
 * trustworthy while the test suite shares the machine.
 */
describe('hill-climb gate: exact metrics against the committed baseline', () => {
  it('makes no more model calls and sends no more prompt tokens per turn', async () => {
    const decks = await loadDecks();
    const current: Report = {
      ...baseline.profiles['quick']!,
      probes: ['model'],
      metrics: await modelProbe(decks, PROFILES['quick']!),
      fingerprints: {},
    };
    const comparison = compareReports(baseline.profiles['quick']!, current);
    expect(comparison.failures).toEqual([]);
    expect(comparison.rows.length).toBeGreaterThanOrEqual(6);
  }, 120_000);

  it('models no fewer cards', async () => {
    const decks = await loadDecks();
    const current: Report = {
      ...baseline.profiles['quick']!,
      probes: ['coverage'],
      metrics: coverageProbe(decks),
      fingerprints: {},
    };
    const comparison = compareReports(baseline.profiles['quick']!, current);
    expect(comparison.failures).toEqual([]);
    expect(comparison.rows.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
});

describe('hill-climb gate: the compiler text check', () => {
  it('settles no fewer trial patches and matches no fewer pool cards', () => {
    const current: Report = {
      ...baseline.profiles['quick']!,
      probes: ['compiler'],
      metrics: compilerProbe(),
      fingerprints: {},
    };
    const comparison = compareReports(baseline.profiles['quick']!, current);
    expect(comparison.failures).toEqual([]);
    expect(comparison.rows.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe('engineProbe', () => {
  it('plays the same seeds to the same fingerprints on every repeat', async () => {
    const decks = await loadDecks();
    const profile = { ...PROFILES['quick']!, engineGames: 2, engineTurnCap: 6 };
    const first = engineProbe(decks, profile, 2, () => {});
    const second = engineProbe(decks, profile, 1, () => {});
    expect(Object.keys(first.fingerprints)).toEqual(['0', '3']);
    expect(second.fingerprints).toEqual(first.fingerprints);
    expect(first.metrics['engine.msPerDecision']!.kind).toBe('timed');
    expect(first.metrics['engine.msPerDecision']!.value).toBeGreaterThan(0);
  }, 120_000);
});

describe('probe helpers', () => {
  it('reports the fastest repeat and the spread between repeats', () => {
    expect(timed([12, 10, 11], 'ms')).toEqual({
      value: 10,
      unit: 'ms',
      better: 'lower',
      kind: 'timed',
      spread: 0.2,
    });
    expect(timed([7], 'ms').spread).toBe(0);
  });

  it('calibrates to a positive time', () => {
    expect(calibrate()).toBeGreaterThan(0);
  });

  it('counts modeled pinned cards and their share of all EDHREC slots', () => {
    const real = (JSON.parse(readFileSync(PINNED_ORACLE_PATH, 'utf8')) as PinnedCard[])[0]!;
    const nonsense: OracleCard = {
      ...real.card,
      oracleId: 'nonsense',
      name: 'Nonsense',
      oracleText: 'Flibbertigibbet the wocket seventeen times.',
    };
    const pins: PinnedCard[] = [
      { rank: 1, card: real.card },
      { rank: 2, card: nonsense },
    ];
    const ranking = {
      totalSlots: 1000,
      cards: [
        [real.card.name, 250, 'nonland'],
        ['Nonsense', 500, 'nonland'],
      ] as Array<[string, number, 'land' | 'nonland']>,
    };
    expect(edhrecCoverage(pins, ranking)).toEqual({ modeled: 1, slotSharePct: 25 });
  });

  it('replays the compiler screen over the committed trials without losing a compiled card', () => {
    const metrics = compilerScreenMetrics();
    expect(metrics['coverage.compilerScreenLosses']!.value).toBe(0);
    expect(metrics['coverage.compilerScreenCatches']!.value).toBeGreaterThanOrEqual(11);
    expect(metrics['coverage.compilerScreenCatches']!.kind).toBe('exact');
  });

  it('reads the optional backlog and deck-coverage reports', () => {
    expect(backlogRefusals({ refusals: 221 })).toBe(221);
    expect(backlogRefusals({})).toBeNull();
    expect(
      playableDeckPct({
        populations: [
          { summary: { decks: 13, playableExactly: 13 } },
          { summary: { decks: 187, playableExactly: 37 } },
        ],
      }),
    ).toBe(25);
    expect(playableDeckPct({ populations: [] })).toBeNull();
  });
});
