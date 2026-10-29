/**
 * Run one scripted table game on loopback, in workers, and print the report as JSON (plans M3
 * and M4 exits). Exit code 0 when the game finished and every check passed.
 *
 *   bun run packages/server/src/cli/table-scripted-run.ts [--turn-cap 6]
 *   bun run packages/server/src/cli/table-scripted-run.ts --scenario disconnect
 *
 * The default is two scripted seats and two bots, untimed. `disconnect` seats four scripted
 * players at a relaxed clock scaled 60 times faster; P2 drops its socket after two decisions,
 * stays away past its grace, then resumes on a new socket and takes control back.
 */

import { runScriptedTable, type ScriptedRunOptions } from '../table/scripted-run';

const argv = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const turnCap = valueOf('--turn-cap');
const scenario = valueOf('--scenario') ?? 'default';

const options: ScriptedRunOptions = {
  ...(scenario === 'disconnect' && {
    // Long enough that the dropped player comes back to a game still running.
    turnCap: 20,
    humans: 4,
    clock: 'relaxed',
    clockScale: 60,
    disconnect: { seat: 'P2', afterDecisions: 2, awayMs: 1_500 },
  }),
  ...(turnCap !== undefined && { turnCap: Number(turnCap) }),
};
if (scenario !== 'default' && scenario !== 'disconnect') {
  process.stderr.write(`unknown scenario ${scenario}\n`);
  process.exit(2);
}

const report = await runScriptedTable(options);
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
