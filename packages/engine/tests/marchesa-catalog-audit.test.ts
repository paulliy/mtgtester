import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface AuditLedger {
  schemaVersion: number;
  sourceFile: string;
  batches: {
    id: string;
    sourceFile?: string;
    cards: {
      oracleId: string;
      name: string;
      implementationStatus: string;
      engineEvidence?: string;
      viewerEvidence?: string;
    }[];
  }[];
  remainingOverrideFiles: {
    sourceFile: string;
    uniqueOracleIds: number;
    status: string;
    note?: string;
    reviewedOracleIds?: number;
    grandfatheredOracleIds?: number;
  }[];
  /**
   * Reviewed cards whose registration was deleted because the interpreter alone now models them
   * faithfully (overrides/index.ts rule 5). Their batch rows stay as review history.
   */
  interpreterRestored?: {
    oracleId: string;
    name: string;
    sourceFile: string;
    restoredIn: string;
    note: string;
  }[];
}

const SOURCE = join(import.meta.dirname, '../src/cards/overrides/marchesa-the-black-rose.ts');
const LEDGER = join(import.meta.dirname, '../../../docs/plans/card-catalog-audit.json');
const OVERRIDES_DIR = join(import.meta.dirname, '../src/cards/overrides');

function uniqueRegistrations(source: string): Map<string, string> {
  const unique = new Map<string, string>();
  const pattern =
    /(?:defineCard|extendCard|unsupportedCard|replaceCard|unimplemented)\(\s*['"]([0-9a-f-]{36})['"],\s*(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)")/g;
  for (const match of source.matchAll(pattern)) {
    const name = (match[2] ?? match[3] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
    unique.set(match[1]!, name);
  }
  return unique;
}

describe('Marchesa override catalog audit inventory', () => {
  it('classifies every unique Oracle ID as reviewed in a batch or grandfathered unreviewed', () => {
    const source = readFileSync(SOURCE, 'utf8');
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as AuditLedger;
    expect(ledger.sourceFile).toBe(
      'packages/engine/src/cards/overrides/marchesa-the-black-rose.ts',
    );

    const unique = uniqueRegistrations(source);
    // Reviewed cards whose registration was deleted because the interpreter now models them.
    const restored = new Set(
      (ledger.interpreterRestored ?? [])
        .filter((entry) => entry.sourceFile === ledger.sourceFile)
        .map((entry) => entry.oracleId),
    );
    const reviewed = new Map<string, string>();
    for (const batch of ledger.batches) {
      if ((batch.sourceFile ?? ledger.sourceFile) !== ledger.sourceFile) continue;
      for (const card of batch.cards) {
        if (restored.has(card.oracleId)) {
          expect(unique.has(card.oracleId), `${card.name} must no longer be registered`).toBe(
            false,
          );
          continue;
        }
        expect(unique.get(card.oracleId), card.name).toBe(card.name);
        reviewed.set(card.oracleId, card.implementationStatus);
      }
    }

    const grandfathered = [...unique.entries()].filter(([id]) => !reviewed.has(id));
    expect(restored.size).toBe(21);
    expect(unique.size).toBe(44 - restored.size);
    expect(reviewed.size).toBe(44 - restored.size);
    expect(grandfathered.length).toBe(0);
    expect(
      [...reviewed.values()].every(
        (status) => status === 'unsupported' || status === 'implemented-reviewed',
      ),
    ).toBe(true);
  });

  it('distinguishes engine-evidenced Marchesa cards from inspection-only leftovers', () => {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as AuditLedger;
    const engineBatch1 = ledger.batches.find((batch) => batch.id === 'marchesa-engine-batch-1');
    expect(engineBatch1?.cards.map((card) => card.name)).toEqual([
      'Grave Pact',
      'Herald of Secret Streams',
      'Pawn of Ulamog',
    ]);
    const engineBatch2 = ledger.batches.find((batch) => batch.id === 'marchesa-engine-batch-2');
    expect(engineBatch2?.cards.map((card) => card.name)).toEqual([
      'Anathemancer',
      'Disciple of Bolas',
      'Fierce Guardianship',
      'Forge of Heroes',
      'Madame Null, Power Broker',
      'Mahadi, Emporium Master',
    ]);
    const engineBatch3 = ledger.batches.find((batch) => batch.id === 'marchesa-engine-batch-3');
    expect(engineBatch3?.cards.map((card) => card.name)).toEqual([
      "Dack's Duplicate",
      'Kalain, Reclusive Painter',
      'Marchesa, the Black Rose',
      'Spark Double',
    ]);
    for (const card of [...engineBatch1!.cards, ...engineBatch2!.cards, ...engineBatch3!.cards]) {
      expect(card.engineEvidence, card.name).toBe('engine-tests');
      expect(card.viewerEvidence, card.name).toBe('not-run');
    }
    const inspectionLeftovers = ledger.batches.find(
      (batch) => batch.id === 'marchesa-reviewed-leftovers',
    );
    expect(inspectionLeftovers?.cards).toEqual([]);
  });

  it('inventories remaining override files as unreviewed until a later batch', () => {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as AuditLedger;
    const listed = new Map(ledger.remainingOverrideFiles.map((entry) => [entry.sourceFile, entry]));
    const skip = new Set([
      'index.ts',
      'snapshot.ts',
      'marchesa-the-black-rose.ts',
      'reviewed-five.ts',
      // Coverage PR01 cards with no earlier registration, gated by pr01-card-coverage.test.ts.
      'coverage-pr01.ts',
      'coverage-pr02.ts',
      'coverage-pr03.ts',
      'coverage-pr06.ts',
      'coverage-pr07.ts',
      'coverage-pr08.ts',
      'coverage-pr09.ts',
    ]);
    const remaining = readdirSync(OVERRIDES_DIR)
      .filter((file) => file.endsWith('.ts') && !skip.has(file))
      .sort();
    expect(remaining.map((file) => `packages/engine/src/cards/overrides/${file}`)).toEqual(
      [...listed.keys()].sort(),
    );
    for (const file of remaining) {
      const sourceFile = `packages/engine/src/cards/overrides/${file}`;
      const entry = listed.get(sourceFile)!;
      const unique = uniqueRegistrations(readFileSync(join(OVERRIDES_DIR, file), 'utf8'));
      expect(unique.size, file).toBe(entry.uniqueOracleIds);
      const restoredHere = new Map(
        (ledger.interpreterRestored ?? [])
          .filter((restored) => restored.sourceFile === sourceFile)
          .map((restored) => [restored.oracleId, restored.name]),
      );
      for (const [oracleId, name] of restoredHere) {
        expect(unique.has(oracleId), `${name} must no longer be registered in ${file}`).toBe(false);
      }
      const fileBatches = ledger.batches.filter(
        (batch) => (batch.sourceFile ?? ledger.sourceFile) === sourceFile,
      );
      if (entry.status === 'out-of-scope') {
        expect(fileBatches, file).toEqual([]);
        expect(entry.note, file).toMatch(/out of coverage/);
        continue;
      }
      if (entry.status === 'unreviewed') {
        expect(fileBatches, file).toEqual([]);
        continue;
      }
      expect(entry.status, file).toBe('reviewed');
      const reviewed = new Set(
        fileBatches.flatMap((batch) => batch.cards.map((card) => card.oracleId)),
      );
      expect(reviewed.size, file).toBe(entry.reviewedOracleIds);
      expect(unique.size - (reviewed.size - restoredHere.size), file).toBe(
        entry.grandfatheredOracleIds,
      );
      for (const batch of fileBatches) {
        for (const card of batch.cards) {
          if (restoredHere.has(card.oracleId)) {
            expect(restoredHere.get(card.oracleId), card.name).toBe(card.name);
            continue;
          }
          expect(unique.get(card.oracleId), card.name).toBe(card.name);
        }
      }
    }
  });
});
