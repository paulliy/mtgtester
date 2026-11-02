/**
 * ADR 0036 decision 7: the full-suite job writes Vitest's JSON report while the suite runs, and this
 * turns it into the `vitest list --json` listing that `check:suite-collect`, `check:manifest-tests`
 * and `mutate-cards` read with `--collected`. Listing the collection separately imported every
 * suite a second time (about 7 minutes on CI). `vitest list` leaves out tests skipped or marked todo
 * in the source, so they are dropped here too; the suite skips nothing at run time (the
 * `test-skips` lint allows only annotated `skip`, `skipIf` and `todo`).
 *
 *   bun run scripts/vitest-run-listing.ts <report.json> <listing.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [reportPath, listingPath] = process.argv.slice(2);
if (reportPath === undefined || listingPath === undefined) {
  console.error('usage: bun run scripts/vitest-run-listing.ts <report.json> <listing.json>');
  process.exit(1);
}

interface Report {
  testResults: { name: string; assertionResults: Assertion[] }[];
}
interface Assertion {
  ancestorTitles: string[];
  title: string;
  status: string;
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
  console.error(`${reportPath}: no test files in the Vitest report`);
  process.exit(1);
}
const listed = new Set(['passed', 'failed']);
const dropped = new Set(['skipped', 'pending', 'todo']);
const listing: { name: string; file: string }[] = [];
for (const file of report.testResults) {
  for (const test of file.assertionResults) {
    if (dropped.has(test.status)) continue;
    if (!listed.has(test.status)) {
      console.error(`${file.name}: unexpected test status ${test.status}: ${test.title}`);
      process.exit(1);
    }
    listing.push({ name: [...test.ancestorTitles, test.title].join(' > '), file: file.name });
  }
}
writeFileSync(listingPath, JSON.stringify(listing));
console.log(`${listing.length} tests in ${report.testResults.length} files`);
