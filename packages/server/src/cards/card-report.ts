/**
 * What the Import report shows for a card (ADR 0054): its Oracle text, how far the engine has come
 * with it, the evidence the audit ledger holds, and the Card Test Lab scenarios pinned to it.
 *
 * Status comes from three real sources and is never invented:
 *   - `interpretCard(card).modeled` (with the interpreter's `unmodeledReasons`);
 *   - the provisional catalog the server admitted, if any (ADR 0050);
 *   - `docs/plans/card-catalog-audit.json`, which records `implemented-reviewed` and `unsupported`
 *     per Oracle id, with the Oracle hash its review was made against.
 * A modeled card the ledger does not call reviewed (or whose reviewed hash no longer matches) is
 * `implemented-unreviewed`. Evidence fields are copied only where the ledger has them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { interpretCard } from '@mtg/engine';
import type {
  CardReport,
  CardReportEntry,
  CardReportEvidence,
  CardReportScenario,
  CardReportStatus,
  CardTestScenarioMetadata,
  OracleCard,
} from '@mtg/shared';
import { oracleSha256 } from './unmodeled';
import type { OracleIndex } from './oracle-index';
import { isProvisional, type ProvisionalCatalog } from './provisional';

export const CATALOG_AUDIT_PATH = 'docs/plans/card-catalog-audit.json';

/** A request naming more cards than this is refused with a 400. */
export const CARD_REPORT_MAX_NAMES = 250;

/** The audit ledger's entry for one Oracle id, as the ledger writes it. */
export interface AuditEntry {
  oracleId: string;
  name: string;
  oracleSha256?: string;
  implementationStatus: string;
  unsupportedReason?: string;
  engineEvidence?: string;
  viewerEvidence?: string;
  gameplayAiEvidence?: string;
  evidenceNote?: string;
  engineTestIds?: string[];
  viewerScenarioId?: string;
}

/** The ledger by Oracle id, merged across its batches. */
export type CatalogAudit = ReadonlyMap<string, AuditEntry>;

export { describeUnmodeled, oracleSha256 } from './unmodeled';

/**
 * Read and merge the ledger. An entry that says `unsupported` wins over any other batch's entry
 * for the same id; otherwise the later batch wins (the rule `catalog-engine-evidence.test.ts`
 * applies). Null when the file is missing or unreadable: the report then has no evidence, and says so.
 */
export function loadCatalogAudit(path: string = CATALOG_AUDIT_PATH): CatalogAudit | null {
  try {
    const file = resolve(path);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      batches?: { cards?: AuditEntry[] }[];
    };
    const merged = new Map<string, AuditEntry>();
    for (const batch of parsed.batches ?? []) {
      for (const entry of batch.cards ?? []) {
        const previous = merged.get(entry.oracleId);
        if (
          previous === undefined ||
          entry.implementationStatus === 'unsupported' ||
          previous.implementationStatus !== 'unsupported'
        )
          merged.set(entry.oracleId, entry);
      }
    }
    return merged;
  } catch {
    return null;
  }
}

let cachedAudit: CatalogAudit | null | undefined;
/** The ledger, read once per process. */
export function catalogAudit(): CatalogAudit | null {
  if (cachedAudit === undefined) cachedAudit = loadCatalogAudit();
  return cachedAudit;
}

/**
 * The status of one card. `modeled` is the interpreter's own verdict; the ledger can only add
 * `implemented-reviewed` to a card the interpreter still models under the Oracle text it reviewed.
 */
export function cardStatus(
  card: OracleCard,
  provisional: ProvisionalCatalog | undefined,
  audit: CatalogAudit | null,
  sha: string = oracleSha256(card),
): CardReportStatus {
  const definition = interpretCard(card);
  if (!definition.modeled) return isProvisional(provisional, card) ? 'provisional' : 'unsupported';
  const entry = audit?.get(card.oracleId);
  if (
    entry?.implementationStatus === 'implemented-reviewed' &&
    (entry.oracleSha256 === undefined || entry.oracleSha256 === sha)
  )
    return 'implemented-reviewed';
  return 'implemented-unreviewed';
}

function evidenceOf(entry: AuditEntry, sha: string): CardReportEvidence {
  return {
    ...(entry.engineEvidence !== undefined && { engine: entry.engineEvidence }),
    ...(entry.viewerEvidence !== undefined && { viewer: entry.viewerEvidence }),
    ...(entry.gameplayAiEvidence !== undefined && { gameplayAi: entry.gameplayAiEvidence }),
    ...(entry.evidenceNote !== undefined && { note: entry.evidenceNote }),
    ...(entry.engineTestIds !== undefined && { engineTestIds: entry.engineTestIds }),
    ...(entry.viewerScenarioId !== undefined && { viewerScenarioId: entry.viewerScenarioId }),
    ...(entry.oracleSha256 !== undefined && { oracleMatchesAudit: entry.oracleSha256 === sha }),
  };
}

export interface CardReportDeps {
  index: OracleIndex;
  provisional?: ProvisionalCatalog | undefined;
  audit: CatalogAudit | null;
  /** The Card Test Lab catalog, or null when this server does not run the lab. */
  scenarios: readonly CardTestScenarioMetadata[] | null;
}

/** One card's report entry. */
export function reportCard(card: OracleCard, deps: CardReportDeps): CardReportEntry {
  const sha = oracleSha256(card);
  const definition = interpretCard(card);
  const entry = deps.audit?.get(card.oracleId);
  const status = cardStatus(card, deps.provisional, deps.audit, sha);
  // The ledger is a record of reviews made at a point in time. Its "unsupported" entries predate
  // the fixes that later restored some cards, so an entry the engine now contradicts is reported
  // as a conflict instead of being shown as this card's evidence.
  const unmodeled = status === 'unsupported' || status === 'provisional';
  const conflicting =
    entry !== undefined && (entry.implementationStatus === 'unsupported') !== unmodeled;
  const scenarios: CardReportScenario[] | null =
    deps.scenarios === null
      ? null
      : deps.scenarios
          .filter((s) => s.oracleSha256 === sha)
          .map((s) => ({ id: s.id, title: s.title, clauseIds: s.clauseIds }));
  return {
    name: card.name,
    oracleId: card.oracleId,
    typeLine: card.typeLine,
    manaCost: card.manaCost,
    oracleText: card.oracleText,
    oracleSha256: sha,
    status,
    unmodeledReasons: definition.modeled ? [] : [...definition.unmodeledReasons],
    ...(!conflicting &&
      entry?.unsupportedReason !== undefined && { unsupportedReason: entry.unsupportedReason }),
    ...(!conflicting && entry !== undefined && { evidence: evidenceOf(entry, sha) }),
    ...(conflicting && {
      auditConflict: `The audit ledger records this card as ${entry.implementationStatus}, but the engine reads it as ${status}.`,
    }),
    scenarios,
  };
}

/** The report for the asked names, in order and without repeats. */
export function buildCardReport(names: readonly string[], deps: CardReportDeps): CardReport {
  const cards: CardReportEntry[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const card = deps.index.resolve(name);
    if (card === null) {
      if (!unresolved.includes(name)) unresolved.push(name);
      continue;
    }
    if (seen.has(card.oracleId)) continue;
    seen.add(card.oracleId);
    cards.push(reportCard(card, deps));
  }
  return {
    cards,
    unresolved,
    auditAvailable: deps.audit !== null,
    labAvailable: deps.scenarios !== null,
  };
}
