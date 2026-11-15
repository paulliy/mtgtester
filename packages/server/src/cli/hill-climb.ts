/**
 * The hill-climb command: measure the project's cost metrics and compare them with a baseline.
 *
 *   bun run hill-climb                      # measure, compare with the committed baseline
 *   bun run hill-climb --quick              # the small profile, about 20 seconds
 *   bun run hill-climb --save F             # also write this run's report to F
 *   bun run hill-climb --against F          # compare with a report saved earlier on this machine
 *   bun run hill-climb --only engine,model  # run some probes: engine, setup, model, coverage
 *   bun run hill-climb --repeat N           # repeat the timed probes N times (default 1)
 *   bun run hill-climb --allow-behavior-change   # the games are meant to differ
 *   bun run hill-climb --write-baseline     # measure both profiles and rewrite the baseline
 *   bun run hill-climb --json               # print the report and comparison as JSON
 *
 * Exits 1 when a metric regressed or went missing, or when a benchmark game played differently.
 * Uses no network and no paid model. See docs/guides/hill-climbing.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PROBES, PROFILES, measure, type Probe } from '../hill-climb/probes';
import { compareReports, renderComparison, type Baseline, type Report } from '../hill-climb/report';

export const BASELINE_PATH = 'packages/server/fixtures/hill-climb-baseline.json';
/** Repeats used for the committed baseline, so it records how noisy each timing is. */
const BASELINE_REPEATS = 3;

interface Args {
  profile: string;
  probes: Probe[];
  repeats: number;
  save: string | null;
  against: string | null;
  allowBehaviorChange: boolean;
  writeBaseline: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: 'standard',
    probes: [...PROBES],
    repeats: 1,
    save: null,
    against: null,
    allowBehaviorChange: false,
    writeBaseline: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--quick') args.profile = 'quick';
    else if (arg === '--save') args.save = value();
    else if (arg === '--against') args.against = value();
    else if (arg === '--allow-behavior-change') args.allowBehaviorChange = true;
    else if (arg === '--write-baseline') args.writeBaseline = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--repeat') {
      args.repeats = Number(value());
      if (!Number.isSafeInteger(args.repeats) || args.repeats < 1)
        throw new Error('--repeat takes a whole number of at least 1');
    } else if (arg === '--only') {
      const names = value().split(',');
      const unknown = names.filter((name) => !(PROBES as readonly string[]).includes(name));
      if (unknown.length > 0)
        throw new Error(`unknown probe ${unknown.join(', ')}; the probes are ${PROBES.join(', ')}`);
      args.probes = PROBES.filter((probe) => names.includes(probe));
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (args.writeBaseline && (args.against !== null || args.probes.length !== PROBES.length))
    throw new Error('--write-baseline measures every probe and takes no --against or --only');
  return args;
}

function printReport(report: Report): void {
  for (const [id, metric] of Object.entries(report.metrics)) {
    const spread =
      metric.kind === 'timed' && report.repeats > 1
        ? `, runs within ${((metric.spread ?? 0) * 100).toFixed(0)}%`
        : '';
    console.log(`${id}: ${metric.value} ${metric.unit} (${metric.better} is better${spread})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => console.error(line);

  if (args.writeBaseline) {
    const baseline: Baseline = { schema: 1, profiles: {} };
    for (const profile of Object.keys(PROFILES)) {
      log(`measuring the ${profile} profile, ${BASELINE_REPEATS} repeats…`);
      baseline.profiles[profile] = await measure({
        profile,
        probes: PROBES,
        repeats: BASELINE_REPEATS,
        log,
      });
    }
    if (Object.values(baseline.profiles).some((report) => report.dirty))
      log('warning: the working tree has uncommitted changes; commit, then write the baseline');
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wrote ${BASELINE_PATH}`);
    return;
  }

  let baseline: Report | undefined;
  let source: string;
  if (args.against !== null) {
    baseline = JSON.parse(readFileSync(args.against, 'utf8')) as Report;
    source = args.against;
    if (baseline.profile !== args.profile)
      throw new Error(
        `${args.against} is a ${baseline.profile} report; rerun with the same profile`,
      );
  } else {
    source = `${BASELINE_PATH} (${args.profile})`;
    if (existsSync(BASELINE_PATH))
      baseline = (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline).profiles[
        args.profile
      ];
  }

  const report = await measure({
    profile: args.profile,
    probes: args.probes,
    repeats: args.repeats,
    log,
  });
  if (args.save !== null) writeFileSync(args.save, `${JSON.stringify(report, null, 2)}\n`);

  if (baseline === undefined) {
    if (args.json) console.log(JSON.stringify({ report }, null, 2));
    else printReport(report);
    console.error(`no baseline at ${source}: nothing compared`);
    process.exitCode = 1;
    return;
  }
  const comparison = compareReports(baseline, report, {
    allowBehaviorChange: args.allowBehaviorChange,
  });
  if (args.json) console.log(JSON.stringify({ report, comparison }, null, 2));
  else {
    console.log(`compared with ${source}, measured at ${baseline.commit}`);
    console.log(renderComparison(comparison));
    for (const failure of comparison.failures) console.log(`FAIL: ${failure}`);
    if (args.against === null && comparison.fingerprints.verdict === 'changed')
      console.log(
        `If main changed the games after ${baseline.commit}, the baseline is stale for fingerprints: ` +
          'save a report on your base commit with --save and compare with --against.',
      );
    const wins = comparison.rows.filter((row) => row.verdict === 'improved').map((row) => row.id);
    console.log(
      comparison.ok
        ? wins.length > 0
          ? `ok: real improvement in ${wins.join(', ')}`
          : 'ok: no regression, and no change larger than the noise'
        : 'failed',
    );
  }
  if (!comparison.ok) process.exitCode = 1;
}

await main();
