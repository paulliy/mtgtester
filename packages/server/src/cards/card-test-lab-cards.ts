/**
 * What the Card Test Lab page shows about each card, keyed by the Oracle hash its scenarios pin.
 * The lab server's Oracle index is empty, so nothing here looks a card up by name.
 *
 * Sources, and only these:
 *   - the verification manifest (`packages/server/fixtures/card-verification-manifest.json`): the
 *     card's name, status, unsupported reason, clause list and per-clause mappings, found by hash;
 *   - the audit ledger (`docs/plans/card-catalog-audit.json`): engine, viewer and gameplay AI
 *     evidence, used only when its entry pins the same hash the scenarios do.
 * Anything neither holds is absent from the result.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CardTestLabCard,
  CardTestLabClause,
  CardTestLabLedgerEvidence,
  CardTestScenarioMetadata,
} from '@mtg/shared';
import { catalogAudit, type AuditEntry, type CatalogAudit } from './card-report';

export interface LabManifestClause {
  id?: string;
  oracleText: string;
  implementation?: string[];
  engineTestIds?: string[];
  viewerScenarioIds?: string[];
}

export interface LabManifestCard {
  name: string;
  oracleSha256: string;
  implementationStatus?: string;
  unsupportedReason?: string;
  clauses: LabManifestClause[];
  gameplayAiScenarioIds?: string[];
}

/** The manifest's cards by Oracle id, as the file writes them. */
export type LabManifest = Readonly<Record<string, LabManifestCard>>;

export const CARD_VERIFICATION_MANIFEST_URL = new URL(
  '../../fixtures/card-verification-manifest.json',
  import.meta.url,
);

export function loadLabManifest(): LabManifest | null {
  try {
    const parsed = JSON.parse(
      readFileSync(fileURLToPath(CARD_VERIFICATION_MANIFEST_URL), 'utf8'),
    ) as {
      cards?: LabManifest;
    };
    return parsed.cards ?? null;
  } catch {
    return null;
  }
}

function ledgerEvidence(entry: AuditEntry): CardTestLabLedgerEvidence {
  return {
    ...(entry.engineEvidence !== undefined && { engine: entry.engineEvidence }),
    ...(entry.viewerEvidence !== undefined && { viewer: entry.viewerEvidence }),
    ...(entry.gameplayAiEvidence !== undefined && { gameplayAi: entry.gameplayAiEvidence }),
    ...(entry.evidenceNote !== undefined && { note: entry.evidenceNote }),
    ...(entry.engineTestIds !== undefined && { engineTestIds: entry.engineTestIds }),
    ...(entry.viewerScenarioId !== undefined && { viewerScenarioId: entry.viewerScenarioId }),
  };
}

/** The cards of the lab catalog, one per Oracle hash, in first-seen order. */
export function buildCardTestLabCards(
  scenarios: readonly CardTestScenarioMetadata[],
  manifest: LabManifest | null,
  audit: CatalogAudit | null,
): CardTestLabCard[] {
  const manifestByHash = new Map<string, { oracleId: string; card: LabManifestCard }>();
  for (const [oracleId, card] of Object.entries(manifest ?? {}))
    manifestByHash.set(card.oracleSha256, { oracleId, card });
  const auditByHash = new Map<string, AuditEntry>();
  for (const entry of audit?.values() ?? [])
    if (entry.oracleSha256 !== undefined) auditByHash.set(entry.oracleSha256, entry);

  const byHash = new Map<string, CardTestScenarioMetadata[]>();
  for (const scenario of scenarios) {
    const group = byHash.get(scenario.oracleSha256);
    if (group === undefined) byHash.set(scenario.oracleSha256, [scenario]);
    else group.push(scenario);
  }

  const cards: CardTestLabCard[] = [];
  for (const [sha, group] of byHash) {
    const pinned = manifestByHash.get(sha);
    const mapped = new Set<string>();
    const clauses: CardTestLabClause[] = (pinned?.card.clauses ?? []).map((clause) => {
      const viewerScenarioIds = clause.viewerScenarioIds ?? [];
      const scenarioIds = group
        .filter(
          (scenario) =>
            (clause.id !== undefined && scenario.clauseIds.includes(clause.id)) ||
            viewerScenarioIds.includes(scenario.id),
        )
        .map((scenario) => scenario.id);
      for (const id of scenarioIds) mapped.add(id);
      return {
        ...(clause.id !== undefined && { id: clause.id }),
        oracleText: clause.oracleText,
        implementation: clause.implementation ?? [],
        engineTestIds: clause.engineTestIds ?? [],
        viewerScenarioIds,
        scenarioIds,
      };
    });

    // The ledger entry for this card: by the manifest's Oracle id, else by the pinned hash.
    const byId = pinned === undefined ? undefined : audit?.get(pinned.oracleId);
    const entry = byId ?? auditByHash.get(sha);
    const state: CardTestLabCard['audit'] =
      entry === undefined
        ? 'absent'
        : entry.oracleSha256 === undefined
          ? 'unpinned'
          : entry.oracleSha256 === sha
            ? 'current'
            : 'stale';
    const current = state === 'current' ? entry : undefined;

    const name = pinned?.card.name ?? current?.name;
    const oracleId = pinned?.oracleId ?? current?.oracleId;
    const status = pinned?.card.implementationStatus ?? current?.implementationStatus;
    const reason = pinned?.card.unsupportedReason ?? current?.unsupportedReason;
    cards.push({
      oracleSha256: sha,
      ...(name !== undefined && { name }),
      ...(oracleId !== undefined && { oracleId }),
      ...(status !== undefined && { implementationStatus: status }),
      ...(reason !== undefined && { unsupportedReason: reason }),
      manifestPinned: pinned !== undefined,
      clauses,
      unmappedScenarioIds: group.filter((s) => !mapped.has(s.id)).map((s) => s.id),
      gameplayAiScenarioIds: pinned?.card.gameplayAiScenarioIds ?? [],
      audit: state,
      ...(current !== undefined && { ledger: ledgerEvidence(current) }),
    });
  }
  return cards;
}

let cached: CardTestLabCard[] | undefined;
/** The report for the real catalog, built once per process. */
export function cardTestLabCards(
  scenarios: readonly CardTestScenarioMetadata[],
): CardTestLabCard[] {
  cached ??= buildCardTestLabCards(scenarios, loadLabManifest(), catalogAudit());
  return cached;
}
