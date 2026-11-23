/**
 * The last failed import, kept so the Import report can show it and the New game screen can give
 * the pasted list back (ADR 0054). One entry: a newer failure replaces the old one. It is mirrored
 * to `sessionStorage` so a reload keeps it, and every storage call is guarded, because storage can
 * be missing or throw in a private window; without it the report simply lives for the page.
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { UnmodeledCard } from '@mtg/shared';

export const IMPORT_REPORT_STORAGE_KEY = 'decktank.importReport';

export type ImportSourceKind = 'url' | 'plaintext';

export interface FailedImport {
  /** The seat the list was for, "P1" to "P4". */
  seat: string;
  /** Whether `source` is a link or a pasted list. */
  sourceKind: ImportSourceKind;
  /** The link or the pasted text, exactly as typed. */
  source: string;
  /** The archetype the person typed, kept with the list. */
  archetypeTag: string;
  /** Named after the commander when the preview knew one. */
  deckName: string;
  /** The cards the preview said the engine does not model. */
  unmodeled: UnmodeledCard[];
}

const STATUSES = ['unsupported', 'implemented-unreviewed', 'provisional'];

/** Read a stored report, or null for anything that is not exactly the shape written. */
export function parseFailedImport(raw: string | null | undefined): FailedImport | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Partial<FailedImport> | null;
    if (value === null || typeof value !== 'object') return null;
    if (
      typeof value.seat !== 'string' ||
      (value.sourceKind !== 'url' && value.sourceKind !== 'plaintext') ||
      typeof value.source !== 'string' ||
      typeof value.archetypeTag !== 'string' ||
      typeof value.deckName !== 'string' ||
      !Array.isArray(value.unmodeled)
    )
      return null;
    const unmodeled: UnmodeledCard[] = [];
    for (const card of value.unmodeled as Partial<UnmodeledCard>[]) {
      if (typeof card?.name !== 'string' || !STATUSES.includes(card.status as string)) return null;
      unmodeled.push({
        name: card.name,
        status: card.status as UnmodeledCard['status'],
        ...(typeof card.oracleSha256 === 'string' && { oracleSha256: card.oracleSha256 }),
      });
    }
    return {
      seat: value.seat,
      sourceKind: value.sourceKind,
      source: value.source,
      archetypeTag: value.archetypeTag,
      deckName: value.deckName,
      unmodeled,
    };
  } catch {
    return null;
  }
}

function session(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readStored(storage: Pick<Storage, 'getItem'> | undefined): FailedImport | null {
  try {
    return parseFailedImport(storage?.getItem(IMPORT_REPORT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  value: FailedImport | null,
): void {
  try {
    if (value === null) storage?.removeItem(IMPORT_REPORT_STORAGE_KEY);
    else storage?.setItem(IMPORT_REPORT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The report still shows for this page; it just will not survive a reload.
  }
}

export const useImportReportStore = defineStore('importReport', () => {
  const report = ref<FailedImport | null>(readStored(session()));
  /**
   * Whether New game has already taken the pasted list back. Set when a report is filled, so the
   * next visit to New game restores the list once and then leaves the screen alone.
   */
  const restorePending = ref(report.value !== null);

  function fill(value: FailedImport): void {
    report.value = value;
    restorePending.value = true;
    writeStored(session(), value);
  }

  /** The list for New game to put back in the seat, once. */
  function takeDraft(): FailedImport | null {
    if (!restorePending.value || report.value === null) return null;
    restorePending.value = false;
    return report.value;
  }

  function clear(): void {
    report.value = null;
    restorePending.value = false;
    writeStored(session(), null);
  }

  return { report, fill, takeDraft, clear };
});
