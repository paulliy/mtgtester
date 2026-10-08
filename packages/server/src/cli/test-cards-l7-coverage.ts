import fs from 'fs';
import { resolve } from 'node:path';
import { loadScryfallBulkOrNull } from '../cards/scryfall-bulk-fixture';
import { toOracleCard } from '../cards/scryfall';
import {
  EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS,
  VERIFIED_TOKEN_TRIUMPH_CARDS,
} from '../cards/token-triumph-support';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { buildSupportedPool } from '../cards/pool';
import type { CheckResult } from './card-test-reporting';
import { RequiredInputError } from './card-test-reporting';

export function runL7CoverageCheck(): CheckResult {
  const scryfallCards = loadScryfallBulkOrNull();
  if (scryfallCards === null) {
    throw new RequiredInputError(
      'data/scryfall-oracle-cards.json is required for the L7 check - see data/README.md.',
    );
  }

  const oracleCards = scryfallCards.flatMap((raw) => {
    const card = toOracleCard(raw);
    return card === null ? [] : [card];
  });
  const cardsByName = new Map(oracleCards.map((card) => [card.name, card]));
  const supportedPool = buildSupportedPool(oracleCards);
  const supportedNames = new Set(supportedPool.cards.map(({ card }) => card.name));

  let verifiedCount = 0;
  for (const name of VERIFIED_TOKEN_TRIUMPH_CARDS) {
    if (supportedNames.has(name)) {
      verifiedCount++;
    } else {
      console.warn(`L7 inventory warning: verified card ${name} is absent from the supported pool`);
    }
  }

  let containedCount = 0;
  for (const name of EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS) {
    const card = cardsByName.get(name);
    const definition = card === undefined ? undefined : interpretCard(card);
    if (
      definition !== undefined &&
      !definition.modeled &&
      definition.unmodeledReasons.some((reason) => reason.includes('explicitly unsupported:'))
    ) {
      containedCount++;
    } else {
      console.warn(`L7 containment warning: ${name} is not explicitly unsupported`);
    }
  }

  const mdPath = resolve('docs/modelled-cards.md');
  const mdContent = fs.readFileSync(mdPath, 'utf8');
  const totalModeled = supportedPool.cards.filter(({ isLand }) => !isLand).length;
  const documentedTotal = Number(
    mdContent.match(/\*\*Total\*\*: (\d+) modeled non-land cards/)?.[1] ?? Number.NaN,
  );
  const inventoryMatches = documentedTotal === totalModeled;
  if (!inventoryMatches) {
    console.warn(
      `L7 inventory warning: docs/modelled-cards.md reports ${documentedTotal}, expected ${totalModeled}`,
    );
  }

  const totalChecks =
    VERIFIED_TOKEN_TRIUMPH_CARDS.length + EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS.length + 1;
  const passedChecks = verifiedCount + containedCount + (inventoryMatches ? 1 : 0);
  const complete = passedChecks === totalChecks;
  return {
    id: 'l7-inventory',
    label: 'L7 audited support and aggregate inventory',
    kind: 'inventory',
    status: complete ? 'passed' : 'failed',
    executed: totalChecks,
    passed: passedChecks,
    failed: totalChecks - passedChecks,
    skipped: 0,
    detail:
      `${verifiedCount}/${VERIFIED_TOKEN_TRIUMPH_CARDS.length} verified names supported; ` +
      `${containedCount}/${EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS.length} audited unsupported names contained; ` +
      (inventoryMatches
        ? `${totalModeled} modeled non-land cards match the generated inventory`
        : `generated inventory is stale: reports ${documentedTotal}, current pool has ${totalModeled}`),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runL7CoverageCheck();
    console.log(`${result.label}: ${result.status.toUpperCase()} — ${result.detail}`);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
