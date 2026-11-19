/**
 * Every place the engine taps a permanent (ADR 0034 decision 7): it queues `becomesTapped` right
 * after, or this table says why tapping there is not becoming tapped. A new tap site fails until
 * it does one or the other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consumeRegenerationShield } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, spawn } from './fixtures';

const SRC = join(import.meta.dirname, '../src');

/**
 * Tap sites that do not queue `becomesTapped`, by file and the tapping line (and its occurrence
 * when the line repeats), with the reason.
 */
const NOT_BECOMING_TAPPED: Record<string, string> = {
  'effects/resolve.ts: token.tapped = true; #1':
    'a token created tapped and attacking enters tapped; it never becomes tapped (CR 508.4)',
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** Each `x.tapped = true` site: its key, and whether `becomesTapped` is queued within 4 lines. */
function tapSites(): Array<{ key: string; queues: boolean }> {
  const sites: Array<{ key: string; queues: boolean }> = [];
  for (const file of sourceFiles(SRC)) {
    if (file.includes('/testing/')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const seen = new Map<string, number>();
    lines.forEach((line, index) => {
      if (!/\b\w+\.tapped = true;/.test(line)) return;
      const text = line.trim().replace(/\s*\/\/.*$/, '');
      const nth = (seen.get(text) ?? 0) + 1;
      seen.set(text, nth);
      sites.push({
        key: `${relative(SRC, file)}: ${text} #${nth}`,
        queues: lines.slice(index + 1, index + 5).some((next) => next.includes("'becomesTapped'")),
      });
    });
  }
  return sites;
}

describe('tap sites', () => {
  it('each queues becomesTapped or is listed with the reason it does not', () => {
    const sites = tapSites();
    expect(sites.length).toBeGreaterThan(10);
    const unlisted = sites.filter((site) => !site.queues && !(site.key in NOT_BECOMING_TAPPED));
    expect(unlisted.map((site) => site.key)).toEqual([]);
    // A listed site that now queues, or is gone, comes off the table.
    const listed = new Set(sites.filter((site) => !site.queues).map((site) => site.key));
    expect(Object.keys(NOT_BECOMING_TAPPED).filter((key) => !listed.has(key))).toEqual([]);
  });

  it('regeneration taps an untapped creature, which becomes tapped, and not a tapped one', () => {
    for (const tapped of [false, true]) {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(4, forest) }))));
      const watcher = spawn(
        ctx,
        'P1',
        oracle({
          name: 'Tap Watcher',
          typeLine: 'Creature — Watcher',
          manaCost: '{1}',
          power: '1',
          toughness: '1',
          oracleText: 'Whenever Tap Watcher becomes tapped, you gain 1 life.',
        }),
      );
      watcher.tapped = tapped;
      watcher.regenerationShields = 1;
      expect(consumeRegenerationShield(ctx, watcher)).toBe(true);
      expect(watcher.tapped).toBe(true);
      expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual(
        tapped ? [] : ['Tap Watcher'],
      );
    }
  });
});
