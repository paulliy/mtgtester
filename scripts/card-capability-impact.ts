import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '../packages/shared/src';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { indexCardCapabilities } from '../packages/engine/src/cards/capabilities';
import { toOracleCard, type RawScryfallCard } from '../packages/server/src/cards/scryfall';
import { benchmarkSourceHashes } from '../packages/server/src/benchmark/manifest';
import { sha256 } from '../packages/server/src/benchmark/hash';
import {
  cardPrimitiveEligibilityBatch,
  loadPrimitiveEvidence,
} from './contracts/primitive-evidence';

const args = process.argv.slice(2);
let inputOption: string | undefined;
let inputPath: string | undefined;
let evidencePath: string | undefined;
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Capability options require paths');
  if (key === '--oracle-fixture' || key === '--oracle-bulk') {
    if (inputOption) throw new Error('Choose one capability input');
    inputOption = key;
    inputPath = value;
  } else if (key === '--primitive-evidence') {
    if (evidencePath) throw new Error('Duplicate primitive evidence option');
    evidencePath = value;
  } else
    throw new Error(
      'Use card-capabilities [--oracle-fixture path | --oracle-bulk path] [--primitive-evidence directory]',
    );
}
const bulk = inputOption === '--oracle-bulk';
const path = resolve(inputPath ?? 'packages/server/fixtures/coverage-oracle.json');
const bytes = readFileSync(path);
const input: unknown = JSON.parse(bytes.toString('utf8'));
if (!Array.isArray(input)) throw new Error('Capability input must be an Oracle card array');
const sourceHashes = benchmarkSourceHashes(process.cwd());
const cards: OracleCard[] = bulk
  ? (input as RawScryfallCard[])
      .map(toOracleCard)
      .filter((card): card is OracleCard => card !== null)
  : (input as OracleCard[]);
const consumers = [];
const unsupported = [];
const definitions: Record<string, string> = {};
for (const card of cards) {
  if (
    !card ||
    typeof card.oracleId !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(card.oracleId) ||
    typeof card.oracleText !== 'string' ||
    !Array.isArray(card.types)
  ) {
    throw new Error(
      'Capability input requires complete projections with canonical Oracle IDs; fixture aliases need explicit canonical mapping',
    );
  }
  const definition = interpretCard(card);
  if (!definition.modeled) {
    unsupported.push({
      oracleId: card.oracleId,
      name: card.name,
      reasons: definition.unmodeledReasons,
    });
    continue;
  }
  consumers.push({ canonicalOracleId: card.oracleId, definition });
  definitions[card.oracleId] = sha256(definition);
}
const impact = indexCardCapabilities(consumers);
const evidence = evidencePath ? loadPrimitiveEvidence(process.cwd(), evidencePath) : undefined;
const eligibility = evidence
  ? cardPrimitiveEligibilityBatch(
      consumers.map((consumer) => consumer.definition),
      evidence,
    )
  : undefined;
if (JSON.stringify(sourceHashes) !== JSON.stringify(benchmarkSourceHashes(process.cwd()))) {
  throw new Error('Capability implementation sources changed during inventory');
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      scope:
        'final IR dependency inventory; no primitive, card, viewer, or gameplay-AI certification',
      input: {
        adapter: bulk ? 'scryfall-projection-v1' : 'pinned-oracle-projection-v1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        population: input.length,
        projections: cards.length,
        omittedByAdapter: input.length - cards.length,
      },
      sourceHashes,
      modeled: Object.keys(impact.cards).length,
      fingerprints: Object.fromEntries(
        Object.entries(impact.cards).map(([oracleId, dependencies]) => [
          oracleId,
          { capabilities: sha256(dependencies), definition: definitions[oracleId] },
        ]),
      ),
      ...impact,
      ...(evidence && eligibility
        ? {
            primitiveEvidence: {
              testedTree: evidence.testedTree,
              reportSha256: evidence.reportSha256,
              engineProven: evidence.capabilities,
              eligible: eligibility.filter((result) => result.eligible).length,
              blocked: eligibility.filter((result) => !result.eligible).length,
              cards: Object.fromEntries(
                consumers.map((consumer, index) => [
                  consumer.canonicalOracleId,
                  eligibility[index],
                ]),
              ),
              scope:
                'primitive prerequisites only; card, viewer, and gameplay-AI evidence remain separate',
            },
          }
        : {}),
      unsupported: unsupported.sort((a, b) =>
        a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0,
      ),
    },
    null,
    2,
  ),
);
