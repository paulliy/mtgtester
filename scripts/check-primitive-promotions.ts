import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  loadPrimitiveEvidence,
  validateCurrentPrimitiveEvidence,
} from './contracts/primitive-evidence';
import {
  parseReviewManifest,
  primitiveReviewPromotions,
  verifyPrimitiveReviewPromotions,
} from './contracts/primitive-promotions';

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--base' ||
  !/^[\da-f]{40}$/i.test(args[1]!) ||
  args[2] !== '--primitive-evidence'
)
  throw new Error(
    'Use primitive-promotions --base <full commit SHA> --primitive-evidence <directory>',
  );
const path = 'packages/server/fixtures/card-verification-manifest.json';
const previous = parseReviewManifest(
  execFileSync('git', ['show', `${args[1]}:${path}`], { encoding: 'utf8' }),
);
const bytes = readFileSync(path, 'utf8');
const current = parseReviewManifest(bytes);
const promotions = primitiveReviewPromotions(previous, current);
const evidence = loadPrimitiveEvidence(process.cwd(), args[3]!);
verifyPrimitiveReviewPromotions(process.cwd(), current, promotions, evidence);
if (readFileSync(path, 'utf8') !== bytes)
  throw new Error('Review manifest changed during promotion verification');
validateCurrentPrimitiveEvidence(evidence);
console.log(
  JSON.stringify({
    testedTree: evidence.testedTree,
    reportSha256: evidence.reportSha256,
    promotions,
    scope:
      'primitive prerequisites for changed reviewed declarations; historical declarations are not current evidence and card/viewer evidence remains independently required',
  }),
);
