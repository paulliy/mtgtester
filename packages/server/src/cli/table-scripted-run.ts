/**
 * Run one scripted table game on loopback, in workers, and print the report as JSON (plan M3
 * exit). Exit code 0 when the game finished and the frame scan is clean.
 *
 *   bun run packages/server/src/cli/table-scripted-run.ts [--turn-cap 6]
 */

import { runScriptedTable } from '../table/scripted-run';

const argv = process.argv.slice(2);
const capIndex = argv.indexOf('--turn-cap');
const turnCap = capIndex >= 0 ? Number(argv[capIndex + 1]) : undefined;

const report = await runScriptedTable(turnCap === undefined ? {} : { turnCap });
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
